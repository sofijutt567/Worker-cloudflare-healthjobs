/**
 * ============================================================
 * Health Jobs Portal — Cloudflare Worker (FINAL PRODUCTION)
 * ============================================================
 */
async function getGoogleAccessToken(env) {
    const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const now = Math.floor(Date.now() / 1000);
    const claim = btoa(JSON.stringify({
        iss: env.GOOGLE_CLIENT_EMAIL,
        scope: "https://www.googleapis.com/auth/indexing",
        aud: "https://oauth2.googleapis.com/token",
        exp: now + 3600,
        iat: now
    }));
const privateKey = env.GOOGLE_PRIVATE_KEY
    .replace(/\\n/g, '\n')
    .replace(/\n/g, '\n')
    .trim();    const keyData = privateKey
        .replace('-----BEGIN PRIVATE KEY-----', '')
        .replace('-----END PRIVATE KEY-----', '')
        .replace(/\s/g, '');
    const binaryKey = Uint8Array.from(atob(keyData), c => c.charCodeAt(0));
    const cryptoKey = await crypto.subtle.importKey(
        "pkcs8", binaryKey,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false, ["sign"]
    );
    const signingInput = `${header}.${claim}`;
    const signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5", cryptoKey,
        new TextEncoder().encode(signingInput)
    );
    const jwt = `${signingInput}.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`;
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
    });
    const tokenData = await tokenRes.json();
    return tokenData.access_token;
}

async function notifyGoogleIndexing(pageUrl, env) {
    try {
        const token = await getGoogleAccessToken(env);
        const res = await fetch("https://indexing.googleapis.com/v3/urlNotifications:publish", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${token}`
            },
            body: JSON.stringify({ url: pageUrl, type: "URL_UPDATED" })
        });
        const data = await res.json();
        console.log("Google Indexing:", pageUrl, res.status);
        return data;
    } catch(e) {
        console.error("Indexing error:", e);
    }
}
const KV_TTL      = 60 * 60 * 24 * 7;   // 7 دن — job pages rarely change
const KV_TTL_NOTE = 60 * 60 * 24 * 14;  // 14 دن — notes almost never change
const SITE_URL  = "https://healthjobportal.com";
const SITE_NAME = "Health Jobs Portal";
const FALLBACK_IMG = `${SITE_URL}/images/logo.png`;

// 1) Like/comment push-notification backend
const NOTIFY_API_URL = "https://notication-healthjobs.vercel.app";
// 2) FAQ question/answer generation (hacker-chat AI backend)
const FAQ_CHAT_API_URL = "https://hacker-chat-nu.vercel.app/api/chat";

export default {
    async fetch(request, env, ctx) {

        const url = new URL(request.url);

        const corsHeaders = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, X-Admin-Secret, Authorization",
            "Access-Control-Max-Age": "86400"
        };

        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: corsHeaders });
        }

        // ── Cache Invalidation ────────────────────────────────────────────────
// ── Purge ALL jobs cache (bulk) ──────────────────────────────────────────────
if (url.pathname === "/api/purge-all-jobs" && request.method === "POST") {
    const authHeader = request.headers.get("X-Admin-Secret");
    if (!env.ADMIN_SECRET || authHeader !== env.ADMIN_SECRET) {
        return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), {
            status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
    }
    try {
        // List all job: keys and delete them
        let deleted = 0;
        let cursor = undefined;
        do {
            const listed = cursor
                ? await env.JOBS_KV.list({ prefix: "job:", cursor })
                : await env.JOBS_KV.list({ prefix: "job:" });
            await Promise.all(listed.keys.map(k => env.JOBS_KV.delete(k.name)));
            deleted += listed.keys.length;
            cursor = listed.list_complete ? undefined : listed.cursor;
        } while (cursor);
        return new Response(JSON.stringify({ success: true, deleted }), {
            status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
    } catch(e) {
        return new Response(JSON.stringify({ success: false, error: e.message }), {
            status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
    }
}

if (url.pathname === "/api/invalidate-cache" && request.method === "POST") {
    const authHeader = request.headers.get("X-Admin-Secret");
    if (!env.ADMIN_SECRET || authHeader !== env.ADMIN_SECRET) {
        return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), {
            status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
    }
    try {
        const body = await request.json();
        const slug = body.slug;
        const type = body.type || "both";
        const deleted = [];

        if (type === "general_post" || type === "both") {
            await env.JOBS_KV.delete(`update:${slug}`);
            deleted.push(`update:${slug}`);
        }
        if (type === "employer_post" || type === "candidate_post" || type === "both") {
            await env.JOBS_KV.delete(`job:${slug}`);
            deleted.push(`job:${slug}`);
        }
        if (type === "medical_note" || type === "both") {
            await env.JOBS_KV.delete(`note:${slug}`);
            deleted.push(`note:${slug}`);
        }

        // ✅ Google Indexing
        const indexingPromises = [];
        if (type === "general_post") {
            indexingPromises.push(notifyGoogleIndexing(`${SITE_URL}/updates/${slug}`, env));
        }
        if (type === "employer_post" || type === "candidate_post") {
            indexingPromises.push(notifyGoogleIndexing(`${SITE_URL}/jobs/${slug}`, env));
        }
        if (type === "medical_note") {
            indexingPromises.push(notifyGoogleIndexing(`${SITE_URL}/notes/${slug}`, env));
        }
        if (type === "both") {
            indexingPromises.push(notifyGoogleIndexing(`${SITE_URL}/updates/${slug}`, env));
            indexingPromises.push(notifyGoogleIndexing(`${SITE_URL}/jobs/${slug}`, env));
        }

        // ✅ Sitemap Ping
        indexingPromises.push(
            fetch(`https://www.google.com/ping?sitemap=${encodeURIComponent(SITE_URL + '/sitemap.xml')}`)
            .catch(e => console.log("Ping error:", e))
        );

        ctx.waitUntil(Promise.all(indexingPromises));

        return new Response(JSON.stringify({ 
            success: true, 
            message: "Cache cleared + Google notified", 
            deleted 
        }), {
            status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
    } catch (e) {
        return new Response(JSON.stringify({ success: false, error: e.message }), {
            status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
    }
}

    

if (request.method === "POST" && !url.pathname.startsWith("/api/")) {
    return fetch(request);
}
if (url.pathname === "/" || url.pathname === "/index.html") {
    // Pehle origin se fetch karo
    const originRes = await fetch(request);
    const originHtml = await originRes.text();
    
    // Firestore se latest 50 posts ke links lao
    const res = await fetch(
        `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents:runQuery?key=${env.FIREBASE_API_KEY}`,
        {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({
                structuredQuery: {
                    from: [{collectionId: "posts"}],
                    orderBy: [{field: {fieldPath: "postedDateISO"}, direction: "DESCENDING"}],
                    limit: 50
                }
            })
        }
    );
    
    const data = await res.json();
    let linksHtml = '<div style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);">';
    
    (data || []).filter(d => d.document).forEach(d => {
        const f = d.document.fields || {};
        const docId = d.document.name.split("/").pop();
        const type = f.type?.stringValue || "";
        const slug = f.slug?.stringValue || docId;
        const title = f.title?.stringValue || f.desc?.stringValue?.substring(0,60) || "Healthcare Post";
        const url = type === "general_post" 
            ? `/updates/${slug}` 
            : `/jobs/${docId}`;
        linksHtml += `<a href="${url}">${title}</a>`;
    });
    
    linksHtml += '</div>';
    
    // HTML میں body کے بعد inject کرو
    const modifiedHtml = originHtml.replace('</body>', linksHtml + '</body>');
    
    return new Response(modifiedHtml, {
        headers: {
            "Content-Type": "text/html;charset=UTF-8",
            "Cache-Control": "public, max-age=1800"
        }
    });
}
        // ── Sitemap ───────────────────────────────────────────────────────────
        if (url.pathname === "/sitemap.xml") {
            return handleSitemap(env);
        }

        // ── Jobs Route ────────────────────────────────────────────────────────
        if (url.pathname.startsWith("/jobs/")) {
            const slug = url.pathname.replace(/^\/jobs\//, "").replace(/\/$/, "").trim();
            if (!slug) return Response.redirect(`${SITE_URL}/`, 302);

            try {
                const cached = await env.JOBS_KV.get(`job:${slug}`, { type: "text" });
                if (cached) return htmlResponse(cached, { "X-Cache": "HIT" });
            } catch (e) {
                console.error("KV read error:", e);
            }

            let post;
            try {
                post = await fetchFromFirestore(slug, env);
            } catch (e) {
                console.error("Firestore error:", e);
                return errorPage(500, "Server Error", "Could not load this post.");
            }

            if (!post) return errorPage(404, "Post Not Found",
                "This job post may have been removed or the link is incorrect.");

            const verified = await isUserVerified(post.posterId, env);
const html = buildPostPage(post, slug, verified);

            ctx.waitUntil(
                env.JOBS_KV.put(`job:${slug}`, html, { expirationTtl: KV_TTL })
                    .catch(e => console.error("KV write error:", e))
            );

            return htmlResponse(html, { "X-Cache": "MISS" });
        }

        // ── Updates Route ─────────────────────────────────────────────────────
        if (url.pathname.startsWith("/updates/")) {
            const slug = url.pathname.replace(/^\/updates\//, "").replace(/\/$/, "").trim();
            if (!slug) return Response.redirect(`${SITE_URL}/`, 302);

            try {
                const cached = await env.JOBS_KV.get(`update:${slug}`, { type: "text" });
                if (cached) return htmlResponse(cached, { "X-Cache": "HIT" });
            } catch (e) {
                console.error("KV read error (update):", e);
            }

            let post;
            try {
                post = await fetchFromFirestoreBySlug(slug, env);
            } catch (e) {
                console.error("Firestore error (update):", e);
                return errorPage(500, "Server Error", "Could not load this update.");
            }

            if (!post) return errorPage(404, "Update Not Found",
                "This update may have been removed or the link is incorrect.");

const verified = await isUserVerified(post.posterId, env);
const html = buildUpdatePage(post, post._docId || slug, verified);

            ctx.waitUntil(
                env.JOBS_KV.put(`update:${slug}`, html, { expirationTtl: KV_TTL })
                    .catch(e => console.error("KV write error (update):", e))
            );

            return htmlResponse(html, { "X-Cache": "MISS" });
        }

// ── Notes Route ───────────────────────────────────────────────────────
        if (url.pathname.startsWith("/notes/")) {
            const noteId = url.pathname.replace(/^\/notes\//, "").replace(/\/$/, "").trim();
            if (!noteId) return Response.redirect(`${SITE_URL}/notes.html`, 302);

            try {
                const cached = await env.JOBS_KV.get(`note:${noteId}`, { type: "text" });
                if (cached) return htmlResponse(cached, { "X-Cache": "HIT" });
            } catch (e) {
                console.error("KV read error (note):", e);
            }

            let note;
            try {
                note = await fetchNoteFromFirestore(noteId, env);
            } catch (e) {
                console.error("Firestore error (note):", e);
                return errorPage(500, "Server Error", "Could not load this note.");
            }

            if (!note) return errorPage(404, "Note Not Found",
                "This note may have been removed or the link is incorrect.");

            const verified = await isUserVerified(note.posterId, env);
const html = buildNotePage(note, noteId, verified);

            ctx.waitUntil(
                env.JOBS_KV.put(`note:${noteId}`, html, { expirationTtl: KV_TTL_NOTE })
                    .catch(e => console.error("KV write error (note):", e))
            );

            return htmlResponse(html, { "X-Cache": "MISS" });
        }
        // ── Serve Related Pools ───────────────────────────────────────────────
        if (url.pathname === "/api/related-jobs-pool") {
            const pool = await env.JOBS_KV.get("related_jobs_pool", { type: "text" });
            if (pool) return new Response(pool, { headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" } });
            await refreshRelatedPools(env);
            const fresh = await env.JOBS_KV.get("related_jobs_pool", { type: "text" });
            return new Response(fresh || "[]", { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        if (url.pathname === "/api/related-updates-pool") {
            const pool = await env.JOBS_KV.get("related_updates_pool", { type: "text" });
            if (pool) return new Response(pool, { headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" } });
            await refreshRelatedPools(env);
            const fresh = await env.JOBS_KV.get("related_updates_pool", { type: "text" });
            return new Response(fresh || "[]", { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        // ── Click/View Tracker ────────────────────────────────────────────────────
if (url.pathname === "/api/track" && request.method === "POST") {
    try {
        const body = await request.json();
        const { postId, field, collection: col } = body;
        if (!postId || !field) {
            return new Response(JSON.stringify({ error: "Missing params" }), {
                status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
        }
        const collectionName = col || "posts";
        const transformUrl = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents:commit?key=${env.FIREBASE_API_KEY}`;
const fsRes = await fetch(transformUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
        writes: [{
            transform: {
                document: `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${collectionName}/${postId}`,
                fieldTransforms: [{
                    fieldPath: field,
                    increment: { integerValue: "1" }
                }]
            }
        }]
    })
});
const fsData = await fsRes.json();
console.log("Track result:", JSON.stringify(fsData));
        return new Response(JSON.stringify({ success: true }), {
            status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
    } catch(e) {
        return new Response(JSON.stringify({ error: e.message }), {
            status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
    }
}
        // ── Public Indexing Notify ────────────────────────────────────────────
if (url.pathname === "/api/notify-index" && request.method === "POST") {
    try {
        const body = await request.json();
        const slug = body.slug;
        const type = body.type;
        
        if (!slug || !type) {
            return new Response(JSON.stringify({ error: "Missing slug or type" }), {
                status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
        }

        const indexingPromises = [];
        
        if (type === "general_post") {
            indexingPromises.push(notifyGoogleIndexing(`${SITE_URL}/updates/${slug}`, env));
        }
        if (type === "employer_post" || type === "candidate_post") {
            indexingPromises.push(notifyGoogleIndexing(`${SITE_URL}/jobs/${slug}`, env));
        }
        if (type === "medical_note") {
            indexingPromises.push(notifyGoogleIndexing(`${SITE_URL}/notes/${slug}`, env));
        }

        ctx.waitUntil(Promise.all(indexingPromises));

        return new Response(JSON.stringify({ success: true }), {
            status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
    } catch(e) {
        return new Response(JSON.stringify({ error: e.message }), {
            status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
    }
}
// ── Related Pool Refresh (internal/cron) ──────────────────────────────
        if (url.pathname === "/api/refresh-related-pool" && request.method === "POST") {
            const authHeader = request.headers.get("X-Admin-Secret");
            if (!env.ADMIN_SECRET || authHeader !== env.ADMIN_SECRET) {
                return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders });
            }
            await refreshRelatedPools(env);
            return new Response(JSON.stringify({ success: true }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        if (url.pathname === '/notes') {
    return Response.redirect(`${SITE_URL}/notes.html`, 301);
}
        // ── Fallback to origin ────────────────────────────────────────────────
        return fetch(request);
    }
};
// ── Related Pools Refresh ─────────────────────────────────────────────────────
async function refreshRelatedPools(env) {
    const PROJECT = env.FIREBASE_PROJECT_ID;
    const KEY     = env.FIREBASE_API_KEY;

    // Jobs pool
    try {
        const res = await fetch(
            `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents:runQuery?key=${KEY}`,
            { method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ structuredQuery: {
                from: [{ collectionId: "posts" }],
                where: { fieldFilter: { field: { fieldPath: "type" }, op: "EQUAL", value: { stringValue: "employer_post" } } },
                orderBy: [{ field: { fieldPath: "postedDateISO" }, direction: "DESCENDING" }],
                limit: 20
              }})
            }
        );
        const data = await res.json();
        const docs = (data || []).filter(d => d.document).map(d => {
            const f = d.document.fields || {};
            const docId = d.document.name.split("/").pop();
            const imgArr = f.media?.arrayValue?.values || [];
            const thumbUrl = imgArr.find(v => v.mapValue?.fields?.type?.stringValue === "image")
                             ?.mapValue?.fields?.url?.stringValue || f.posterPic?.stringValue || "";
            return {
                id: docId,
                title: f.title?.stringValue || "Healthcare Job",
                location: f.location?.stringValue || "",
                salary: f.salary?.stringValue || "Negotiable",
                posterRole: f.posterRole?.stringValue || "employer",
                posterName: f.posterName?.stringValue || "",
                posterPic: f.posterPic?.stringValue || "",
                thumb: thumbUrl
            };
        });
await env.JOBS_KV.put("related_jobs_pool", JSON.stringify(docs), { expirationTtl: 259200 });
    } catch(e) { console.error("Jobs pool refresh error:", e); }

    // Updates pool
    try {
        const res = await fetch(
            `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents:runQuery?key=${KEY}`,
            { method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ structuredQuery: {
                from: [{ collectionId: "posts" }],
                where: { fieldFilter: { field: { fieldPath: "type" }, op: "EQUAL", value: { stringValue: "general_post" } } },
                orderBy: [{ field: { fieldPath: "postedDateISO" }, direction: "DESCENDING" }],
                limit: 20
              }})
            }
        );
        const data = await res.json();
        const docs = (data || []).filter(d => d.document).map(d => {
            const f = d.document.fields || {};
            const docId = d.document.name.split("/").pop();
            const slug = f.slug?.stringValue || docId;
            const imgArr = f.media?.arrayValue?.values || [];
            const thumbUrl = imgArr.find(v => v.mapValue?.fields?.type?.stringValue === "image")
                             ?.mapValue?.fields?.url?.stringValue || f.posterPic?.stringValue || "";
            const desc = f.desc?.stringValue || "";
            const title = f.title?.stringValue || "";
            return {
                id: docId,
                slug,
                title,
                desc: desc.substring(0, 80) + (desc.length > 80 ? "..." : ""),
                location: f.location?.stringValue || "",
                postedDateISO: f.postedDateISO?.stringValue || "",
                posterPic: f.posterPic?.stringValue || "",
                thumb: thumbUrl
            };
        });
        await env.JOBS_KV.put("related_updates_pool", JSON.stringify(docs), { expirationTtl: 259200 });
    } catch(e) { console.error("Updates pool refresh error:", e); }
}

// ── Sitemap Handler ───────────────────────────────────────────────────────────
async function handleSitemap(env) {
try {
        const cachedSitemap = await env.JOBS_KV.get("sitemap_xml", { type: "text" });
        if (cachedSitemap) {
            return new Response(cachedSitemap, {
                status: 200,
                headers: {
                    "Content-Type": "application/xml; charset=utf-8",
                    "Cache-Control": "public, max-age=3600"
                }
            });
        }
    } catch(e) {}
    let dynamicUrlsXml = "";

    try {
        let nextPageToken = null;

        do {
            const pageParam = nextPageToken ? `&pageToken=${encodeURIComponent(nextPageToken)}` : "";
            const firestoreUrl = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/posts?pageSize=100${pageParam}&key=${env.FIREBASE_API_KEY}`;
            const firestoreRes = await fetch(firestoreUrl);

            if (!firestoreRes.ok) break;

            const firestoreData = await firestoreRes.json();

            if (firestoreData.documents && firestoreData.documents.length > 0) {
                firestoreData.documents.forEach(doc => {
                    const fields = doc.fields || {};
                    const slug   = doc.name.split("/").pop();
                    let lastMod  = new Date().toISOString().split("T")[0];

if (fields.postedDateISO && fields.postedDateISO.stringValue) {
    lastMod = fields.postedDateISO.stringValue.split("T")[0];
} else if (fields.createdAt && fields.createdAt.timestampValue) {
    lastMod = fields.createdAt.timestampValue.split("T")[0];
}

                    // Agar general_post hai toh /updates/ URL use karo, warna /jobs/
                    const postType = fields.type?.stringValue || "";
                    const pathPrefix = postType === "general_post" ? "updates" : "jobs";

                    dynamicUrlsXml += `
  <url>
    <loc>${SITE_URL}/${pathPrefix}/${slug}</loc>
    <lastmod>${lastMod}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>`;
                });
            }

            nextPageToken = firestoreData.nextPageToken || null;

        } while (nextPageToken);
        // Medical Notes
        let notesNextPage = null;
        do {
            const notePageParam = notesNextPage ? `&pageToken=${encodeURIComponent(notesNextPage)}` : "";
            const notesUrl = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/medical_notes?pageSize=100${notePageParam}&key=${env.FIREBASE_API_KEY}`;
            const notesRes = await fetch(notesUrl);
            if (!notesRes.ok) break;
            const notesData = await notesRes.json();
            if (notesData.documents && notesData.documents.length > 0) {
                notesData.documents.forEach(doc => {
                    const docId = doc.name.split("/").pop();
                    const fields = doc.fields || {};
                    let lastMod = new Date().toISOString().split("T")[0];
                    if (fields.createdAt && fields.createdAt.timestampValue) {
                        lastMod = fields.createdAt.timestampValue.split("T")[0];
                    }
                    dynamicUrlsXml += `
  <url>
    <loc>${SITE_URL}/notes/${docId}</loc>
    <lastmod>${lastMod}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>`;
                });
            }
            notesNextPage = notesData.nextPageToken || null;
        } while (notesNextPage);

    } catch (err) {
        console.error("Sitemap Firestore error:", err);
    }

    const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">

  <url>
    <loc>${SITE_URL}/</loc>
    <lastmod>2026-05-19</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>${SITE_URL}/employer.html</loc>
    <lastmod>2026-05-19</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.9</priority>
  </url>
  <url>
    <loc>${SITE_URL}/candidate.html</loc>
    <lastmod>2026-05-19</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.9</priority>
  </url>
  <url>
    <loc>${SITE_URL}/posts.html</loc>
    <lastmod>2026-05-19</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${SITE_URL}/interview.html</loc>
    <lastmod>2026-05-19</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${SITE_URL}/cv-maker.html</loc>
    <lastmod>2026-05-19</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${SITE_URL}/notes.html</loc>
    <lastmod>2026-05-19</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>${SITE_URL}/news.html</loc>
    <lastmod>2026-05-19</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${SITE_URL}/about.html</loc>
    <lastmod>2026-05-19</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>
  <url>
    <loc>${SITE_URL}/privcy.html</loc>
    <lastmod>2026-05-19</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.5</priority>
  </url>
  <url>
    <loc>${SITE_URL}/terms.html</loc>
    <lastmod>2026-05-19</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.5</priority>
  </url>
${dynamicUrlsXml}

</urlset>`;
// ... باقی سارا sitemap code ...

// آخر میں return سے پہلے save کریں:
try {
    await env.JOBS_KV.put("sitemap_xml", sitemapXml, { expirationTtl: 21600 }); // 6 گھنٹے
} catch(e) {}
    return new Response(sitemapXml, {
        status: 200,
        headers: {
            "Content-Type": "application/xml; charset=utf-8",
            "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400"
        }
    });
}

// ── Firestore REST Fetch (by Document ID — /jobs/ route ke liye) ──────────────
async function fetchFromFirestore(slug, env) {
    const firestoreUrl = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/posts/${slug}?key=${env.FIREBASE_API_KEY}`;
    const res = await fetch(firestoreUrl);
    if (!res.ok) return null;
    const json = await res.json();
    if (!json.fields) return null;
    const parsed = parseFields(json.fields);
    parsed._docId = slug;
    return parsed;
}

// ── Firestore REST Fetch (by slug field — /updates/ route ke liye) ────────────
async function fetchFromFirestoreBySlug(slug, env) {
    const firestoreUrl = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents:runQuery?key=${env.FIREBASE_API_KEY}`;

    const body = {
        structuredQuery: {
            from: [{ collectionId: "posts" }],
            where: {
                fieldFilter: {
                    field: { fieldPath: "slug" },
                    op: "EQUAL",
                    value: { stringValue: slug }
                }
            },
            limit: 1
        }
    };

    const res = await fetch(firestoreUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
    });

    const json = await res.json();
    if (!json || json.length === 0 || !json[0].document) return null;

    const docName = json[0].document.name;
    const docId = docName.split("/").pop();
    const parsed = parseFields(json[0].document.fields || {});
    parsed._docId = docId;
    return parsed;
}
// ── Firestore Fetch (medical_notes — by document ID) ──────────────────────────
async function fetchNoteFromFirestore(slug, env) {
    const firestoreUrl = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/medical_notes/${slug}?key=${env.FIREBASE_API_KEY}`;
    const res = await fetch(firestoreUrl);
    if (!res.ok) return null;
    const json = await res.json();
    if (!json.fields) return null;
    const parsed = parseFields(json.fields);
    parsed._docId = slug;
    return parsed;
}
function parseFields(fields) {
    const out = {};
    for (const [k, v] of Object.entries(fields)) out[k] = parseValue(v);
    return out;
}

function parseValue(v) {
    if ("stringValue"    in v) return v.stringValue;
    if ("integerValue"   in v) return Number(v.integerValue);
    if ("doubleValue"    in v) return Number(v.doubleValue);
    if ("booleanValue"   in v) return Boolean(v.booleanValue);
    if ("nullValue"      in v) return null;
    if ("timestampValue" in v) return v.timestampValue;
    if ("arrayValue"     in v) return (v.arrayValue.values || []).map(parseValue);
    if ("mapValue"       in v) return parseFields(v.mapValue.fields || {});
    return null;
}

// ── Job Post Page Builder ─────────────────────────────────────────────────────
function buildPostPage(post, slug, verified = false) {
    const e  = s => String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
    const eJ = s => String(s ?? "").replace(/\\/g,"\\\\").replace(/"/g,'\\"').replace(/\n/g,"\\n");
    const nl = s => e(s).replace(/\n/g,"<br>");

    const title      = post.title        || "Healthcare Job";
    const category   = post.category     || "";
    const city       = post.location     || "";
    const address    = post.address      || city;
    const salary     = post.salary       || "Negotiable";
    const shift      = post.shift        || "Flexible";
    const experience = post.experience   || "Any";
    const desc       = post.desc         || "";
    const posterName = post.posterName   || SITE_NAME;
    const posterPic  = post.posterPic    || `https://ui-avatars.com/api/?name=${encodeURIComponent(posterName)}&background=0a66c2&color=fff`;
    const posterRole = post.posterRole   || "employer";
    const posterId   = post.posterId     || "";
    const whatsapp   = post.whatsapp     || "";
    const localNum   = post.localNum     || "";
    const extLink    = post.externalLink || "";
    const webChat    = post.webChat !== false;
    const postedDate = post.postedDateISO || post.createdAt || "";
    const expiresAt  = post.expiresAt    || null;
    const media      = Array.isArray(post.media) ? post.media : [];
    const salaryMin  = post.salaryMin    || null;
    const salaryMax  = post.salaryMax    || null;
    const empType    = post.employmentType || "FULL_TIME";
    const canonicalUrl = `${SITE_URL}/jobs/${slug}`;
    const postDocId = post._docId || slug;

    const pageTitle = `${title} - ${category} in ${city} | ${SITE_NAME}`;
    const tempDesc = desc.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

const metaDesc = tempDesc.length > 50 
    ? tempDesc.substring(0, 157) + (tempDesc.length > 157 ? "..." : "")
    : `${title} - ${category} job in ${city}. Salary: ${salary}. Experience: ${experience}. Apply now on Health Jobs Portal Pakistan.`;
    const ogImage   = media.find(m => m.type === "image")?.url || FALLBACK_IMG;
    const isEmployer = posterRole === "employer";
    const roleText   = isEmployer ? "Hiring" : "Candidate";
    const badgeClass = isEmployer ? "badge-employer" : "badge-candidate";

    let formattedDate = "Recently";
    if (postedDate) {
        try {
            formattedDate = new Date(postedDate).toLocaleDateString("en-US", {
                day: "numeric", month: "short", year: "numeric"
            });
        } catch(_) {}
    }

    let waNumber = "";
    if (whatsapp.trim()) {
        waNumber = whatsapp.replace(/[^0-9]/g, "");
        if (waNumber.startsWith("0")) waNumber = "92" + waNumber.substring(1);
    }
const callNumber = localNum.trim();
    const waMsg = encodeURIComponent(`Hi, I saw your post "${title}" on Health Jobs Portal and I am interested.`);

    let mediaHtml = "";
    if (media.length > 0) {
        mediaHtml = '<div class="media-container">' + media.map(m => {
            if (m.type === "image") return `<div class="media-item"><img src="${e(m.url)}" alt="${e(title)}" loading="lazy" onclick="openLightbox('${e(m.url)}')" style="cursor:zoom-in;"></div>`;
            if (m.type === "video") return `<div class="media-item"><video src="${e(m.url)}" controls preload="none" style="width:100%;border-radius:8px;border:1px solid var(--border-color);" poster="${e(ogImage)}"></video></div>`;
            if (m.type === "pdf")   return `<div class="media-item"><a href="${e(m.url)}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:8px;padding:12px 16px;background:#f0f7ff;border:1px solid #d0e1fd;border-radius:8px;text-decoration:none;color:#1967d2;font-size:14px;font-weight:600;"><svg width="16" height="16" viewBox="0 0 24 24" fill="#1967d2"><path d="M20 2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg> 📄 ${e(m.name || "View Document")}</a></div>`;
            return "";
        }).join("") + '</div>';
    }

const extLinkHtml = extLink.trim()
    ? `<div onclick="requireAuth(async function(){ await trackClick('${e(slug)}','linkClicks'); window.open('${e(extLink)}','_blank'); })" style="display:inline-flex;align-items:center;gap:8px;margin-top:10px;margin-bottom:5px;padding:10px 16px;background:#f0f7ff;border:1px solid #d0e1fd;border-radius:8px;text-decoration:none;color:#1967d2;font-size:14px;font-weight:600;cursor:pointer;"><svg width="16" height="16" viewBox="0 0 24 24" fill="#1967d2"><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/></svg>Apply Now</div>`
    : "";

const whatsappBtn = waNumber
    ? `<div class="circle-btn-wrapper" style="cursor:pointer;" onclick="requireAuth(async function(){ await trackClick('${e(postDocId)}','whatsappClicks'); window.open('https://wa.me/${e(waNumber)}?text=${waMsg}','_blank'); })"><div class="circle-btn btn-wa"><svg viewBox="0 0 24 24"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51a12.8 12.8 0 0 0-.57-.01c-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z"/></svg></div><span class="btn-label">WhatsApp</span></div>`
    : "";

const callBtn = callNumber
    ? `<div class="circle-btn-wrapper" style="cursor:pointer;" onclick="requireAuth(async function(){ await trackClick('${e(postDocId)}','callClicks'); window.location.href='tel:${e(callNumber)}'; })"><div class="circle-btn btn-call"><svg viewBox="0 0 24 24"><path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/></svg></div><span class="btn-label">Call</span></div>`
    : "";

const chatBtn = (webChat && posterId)
    ? `<div class="circle-btn-wrapper" style="cursor:pointer;" onclick="requireAuth(function(){ trackClick('${e(slug)}','chatClicks'); window.location.href='${SITE_URL}/chat.html?uid=${e(posterId)}'; })"><div class="circle-btn btn-chat"><svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 9h12v2H6V9zm8 5H6v-2h8v2zm4-6H6V6h12v2z"/></svg></div><span class="btn-label">Web Chat</span></div>`
    : "";
    
    let baseSalaryLd = "";
    if (salaryMin) {
        baseSalaryLd = `"baseSalary":{"@type":"MonetaryAmount","currency":"PKR","value":{"@type":"QuantitativeValue","minValue":${salaryMin},${salaryMax ? `"maxValue":${salaryMax},` : ""}"unitText":"MONTH"}},`;
    }
    const validThrough = expiresAt ? `"validThrough":"${eJ(expiresAt)}",` : "";
    const jsonLd = `{"@context":"https://schema.org/","@type":"JobPosting","title":"${eJ(title)}","description":"${eJ(desc)}","datePosted":"${eJ(postedDate || new Date().toISOString())}",${validThrough}"employmentType":"${eJ(empType)}","hiringOrganization":{"@type":"Organization","name":"${eJ(posterName)}","logo":"${eJ(posterPic)}"},"jobLocation":{"@type":"Place","address":{"@type":"PostalAddress",
"streetAddress":"${eJ(address)}",
"addressLocality":"${eJ(city)}",
"addressRegion":"${eJ(post.addressRegion || city)}",
${city ? `"postalCode":"00000",` : ''}
"addressCountry":"PK"}},${baseSalaryLd}"occupationalCategory":"${eJ(category)}","url":"${eJ(canonicalUrl)}"}`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0,user-scalable=no">
<title>${e(pageTitle)}</title>
<meta name="description" content="${e(metaDesc)}">
<meta name="keywords" content="${e(category)}, healthcare jobs Pakistan, ${e(city)} jobs, medical jobs">
<meta name="robots" content="${tempDesc.length < 100 ? 'noindex, follow' : 'index, follow, max-snippet:-1, max-image-preview:large'}">
<link rel="canonical" href="${e(canonicalUrl)}">
<meta property="og:type" content="article">
<meta property="og:url" content="${e(canonicalUrl)}">
<meta property="og:title" content="${e(pageTitle)}">
<meta property="og:description" content="${e(metaDesc)}">
<meta property="og:image" content="${e(ogImage)}">
<meta property="og:site_name" content="${e(SITE_NAME)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${e(pageTitle)}">
<meta name="twitter:description" content="${e(metaDesc)}">
<meta name="twitter:image" content="${e(ogImage)}">
<script type="application/ld+json">${jsonLd}<\/script>
<script>
setTimeout(function(){
let s1=document.createElement('script');s1.src="https://www.googletagmanager.com/gtag/js?id=G-NC0B547PYR";s1.async=true;document.head.appendChild(s1);
let s2=document.createElement('script');s2.innerHTML="window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-NC0B547PYR');";document.head.appendChild(s2);
let s3=document.createElement('script');s3.src="https://analytics.ahrefs.com/analytics.js";s3.setAttribute("data-key","lZziwIFYdWn//NVwsT+mUg");s3.async=true;document.head.appendChild(s3);
},3500);
<\/script>
<style>
.btn-wa{background:#25D366;}.btn-wa:hover{background:#1DA851;transform:translateY(-3px);}
.btn-call{background:#0078FF;}.btn-call:hover{background:#005bb5;transform:translateY(-3px);}
:root{--primary-blue:#0a66c2;--hover-blue:#004182;--bg-white:#ffffff;--bg-body:#f3f2ef;--text-main:#000000e6;--text-secondary:#00000099;--border-color:#e0dfdc;--wa-green:#25D366;--call-blue:#0078FF;}
*{margin:0;padding:0;box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;}
body{background:var(--bg-body);color:var(--text-main);padding-top:70px;padding-bottom:30px;}
header{background:var(--bg-white);padding:0 15px;display:flex;align-items:center;gap:15px;position:fixed;top:0;left:0;width:100%;height:65px;z-index:1000;border-bottom:1px solid var(--border-color);box-shadow:0 1px 3px rgba(0,0,0,0.05);}
.back-btn{background:none;border:none;cursor:pointer;color:var(--text-secondary);display:flex;align-items:center;padding:5px;}
.back-btn:hover{color:var(--primary-blue);}
.back-btn svg{width:26px;height:26px;fill:currentColor;}
.logo-text{font-size:18px;font-weight:700;color:var(--text-main);}
main{width:100%;padding:0 10px;max-width:700px;margin:0 auto;box-sizing:border-box;}
.details-card{background:var(--bg-white);border-radius:12px;border:1px solid var(--border-color);box-shadow:0 2px 4px rgba(0,0,0,0.02);padding:25px;margin-top:10px;}
.user-section{display:flex;align-items:center;gap:15px;margin-bottom:25px;padding-bottom:20px;border-bottom:1px solid #f1f1f1;}
.user-avatar{width:60px;height:60px;border-radius:50%;object-fit:cover;border:1px solid var(--border-color);}
.user-details{flex:1;}
.user-name{font-size:18px;font-weight:700;color:var(--text-main);margin-bottom:4px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.role-badge{font-size:10px;padding:4px 8px;border-radius:12px;text-transform:uppercase;font-weight:800;}
.badge-employer{background:#f0f7ff;color:#1967d2;border:1px solid #d0e1fd;}
.badge-candidate{background:#faf5ff;color:#681da8;border:1px solid #e9d5ff;}
.post-time{font-size:13px;color:var(--text-secondary);font-weight:500;}
.job-title{font-size:24px;font-weight:800;color:var(--primary-blue);line-height:1.3;margin-bottom:20px;}
.highlights-box{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:15px;background:#f8fafc;padding:20px;border-radius:8px;border:1px solid #e2e8f0;margin-bottom:25px;}
.highlight-item{display:flex;flex-direction:column;gap:5px;}
.hl-label{font-size:12px;text-transform:uppercase;font-weight:700;color:var(--text-secondary);letter-spacing:0.5px;}
.hl-value{font-size:15px;font-weight:600;color:var(--text-main);}
.desc-title{font-size:16px;font-weight:700;color:var(--text-main);margin-bottom:10px;}
.job-desc{font-size:15px;line-height:1.7;color:#333;margin-bottom:30px;word-wrap:break-word;overflow-wrap:break-word;}
.media-container{display:flex;flex-direction:column;gap:15px;margin-bottom:20px;}
.media-item img{width:100%;border-radius:8px;border:1px solid var(--border-color);object-fit:cover;max-height:400px;}
.action-bar{position:fixed;bottom:0;left:0;width:100%;background:var(--bg-white);padding:15px 20px;border-top:1px solid var(--border-color);box-shadow:0 -4px 15px rgba(0,0,0,0.08);display:flex;justify-content:center;z-index:1000;}
.action-bar-inner{max-width:450px;width:100%;display:flex;justify-content:space-around;align-items:center;}
.circle-btn-wrapper{display:flex;flex-direction:column;align-items:center;gap:6px;text-decoration:none;cursor:pointer;}
.circle-btn{width:50px;height:50px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:white;box-shadow:0 4px 10px rgba(0,0,0,0.15);transition:0.3s;border:none;cursor:pointer;}
.circle-btn svg{width:24px;height:24px;fill:currentColor;}
.btn-label{font-size:12px;font-weight:700;color:var(--text-main);}
.btn-wa{background:var(--wa-green);}.btn-wa:hover{background:#1DA851;transform:translateY(-3px);box-shadow:0 6px 12px rgba(37,211,102,0.3);}
.btn-call{background:var(--call-blue);}.btn-call:hover{background:#005bb5;transform:translateY(-3px);box-shadow:0 6px 12px rgba(0,120,255,0.3);}
.btn-chat{background:var(--primary-blue);}.btn-chat:hover{background:var(--hover-blue);transform:translateY(-3px);box-shadow:0 6px 12px rgba(10,102,194,0.3);}
.report-popup{position:fixed;bottom:80px;left:50%;transform:translateX(-50%);width:calc(100% - 30px);max-width:480px;background:white;border-radius:14px;border:1px solid #e2e8f0;box-shadow:0 8px 30px rgba(0,0,0,0.15);z-index:9999;padding:18px;display:none;animation:slideUp 0.3s ease;}
.report-popup.show{display:block;}
@keyframes slideUp{from{opacity:0;transform:translateX(-50%) translateY(20px);}to{opacity:1;transform:translateX(-50%) translateY(0);}}
.report-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;}
.report-top h3{font-size:15px;font-weight:700;color:#0f172a;}
.report-close{background:#f1f5f9;border:none;border-radius:50%;width:28px;height:28px;font-size:16px;cursor:pointer;color:#64748b;display:flex;align-items:center;justify-content:center;}
.report-owner-box{display:flex;align-items:center;gap:10px;background:#f8fafc;padding:10px 12px;border-radius:10px;border:1px solid #e2e8f0;margin-bottom:14px;}
.report-owner-box img{width:38px;height:38px;border-radius:50%;object-fit:cover;border:1px solid #e2e8f0;}
.report-reasons{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px;}
.reason-chip{padding:7px 13px;border-radius:20px;border:1px solid #e2e8f0;font-size:12px;font-weight:600;cursor:pointer;background:#f8fafc;color:#334155;transition:0.2s;}
.reason-chip.selected{background:#0a66c2;color:white;border-color:#0a66c2;}
.report-input{width:100%;padding:10px 12px;border:1px solid #e2e8f0;border-radius:8px;font-size:13px;margin-bottom:10px;outline:none;font-family:inherit;}
.report-input:focus{border-color:#0a66c2;}
.report-submit{width:100%;padding:11px;background:#ef4444;color:white;border:none;border-radius:20px;font-size:14px;font-weight:700;cursor:pointer;transition:0.2s;}
.report-submit:hover{background:#dc2626;}
.report-success{text-align:center;padding:10px 0;font-size:14px;color:#16a34a;font-weight:600;display:none;}

/* ── Related Jobs Section ── */
.related-section{margin-top:14px;margin-bottom:6px;background:var(--bg-white);border-radius:12px;border:1px solid var(--border-color);padding:20px;box-shadow:0 2px 4px rgba(0,0,0,0.02);}
.related-heading{font-size:15px;font-weight:800;color:var(--text-main);margin-bottom:12px;display:flex;align-items:center;gap:7px;}
.related-heading svg{width:18px;height:18px;fill:var(--primary-blue);}
.related-grid{display:flex;flex-direction:column;gap:10px;}
.related-card{display:flex;align-items:center;gap:12px;background:var(--bg-white);border:1px solid var(--border-color);border-radius:12px;padding:14px;cursor:pointer;text-decoration:none;transition:box-shadow 0.2s,border-color 0.2s;width:100%;box-sizing:border-box;}
.related-card:hover{box-shadow:0 4px 14px rgba(10,102,194,0.12);border-color:#b8d0f0;}
.related-thumb{width:64px;height:64px;border-radius:10px;object-fit:cover;border:1.5px solid var(--border-color);flex-shrink:0;background:#f0f7ff;}
.related-info{flex:1;min-width:0;}
.related-title{font-size:14px;font-weight:700;color:var(--text-main);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin-bottom:5px;line-height:1.4;}
.related-meta{font-size:11px;color:var(--text-secondary);display:flex;align-items:center;gap:5px;flex-wrap:wrap;}
.related-badge{font-size:9px;padding:2px 7px;border-radius:10px;font-weight:800;text-transform:uppercase;}
.related-badge.emp{background:#f0f7ff;color:#1967d2;border:1px solid #d0e1fd;}
.related-badge.cnd{background:#faf5ff;color:#681da8;border:1px solid #e9d5ff;}
.related-arrow{color:#b0b8c9;flex-shrink:0;}
.related-skeleton{background:#f1f5f9;border-radius:12px;height:92px;animation:shimmer 1.2s infinite linear;background:linear-gradient(90deg,#f1f5f9 25%,#e8edf4 50%,#f1f5f9 75%);background-size:200% 100%;}
@keyframes shimmer{0%{background-position:200% 0;}100%{background-position:-200% 0;}}

/* ── Related Questions (FAQ) Section ── */
.faq-section{margin-top:14px;margin-bottom:6px;background:var(--bg-white);border-radius:12px;border:1px solid var(--border-color);padding:20px;box-shadow:0 2px 4px rgba(0,0,0,0.02);}
.faq-heading{font-size:15px;font-weight:800;color:var(--text-main);margin-bottom:12px;display:flex;align-items:center;gap:7px;}
.faq-heading svg{width:18px;height:18px;fill:var(--primary-blue);}
.faq-list{display:flex;flex-direction:column;gap:8px;}
.faq-skeleton{background:#f1f5f9;border-radius:10px;height:46px;animation:shimmer 1.2s infinite linear;background:linear-gradient(90deg,#f1f5f9 25%,#e8edf4 50%,#f1f5f9 75%);background-size:200% 100%;}
.faq-item{border:1px solid var(--border-color);border-radius:10px;background:var(--bg-white);overflow:hidden;}
.faq-question{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 14px;cursor:pointer;font-size:13.5px;font-weight:600;color:var(--text-main);}
.faq-question .faq-chevron{width:16px;height:16px;flex-shrink:0;transition:transform 0.2s;color:#94a3b8;}
.faq-item.open .faq-question .faq-chevron{transform:rotate(180deg);}
.faq-answer{max-height:0;overflow:hidden;transition:max-height 0.25s ease;}
.faq-answer-inner{padding:0 14px 14px;font-size:13px;color:var(--text-secondary);line-height:1.6;}
.faq-answer-skeleton{height:12px;border-radius:6px;margin-bottom:6px;background:linear-gradient(90deg,#f1f5f9 25%,#e8edf4 50%,#f1f5f9 75%);background-size:200% 100%;animation:shimmer 1.2s infinite linear;}
.expiry-badge{display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:20px;font-size:12px;font-weight:700;margin-bottom:10px;}
.expiry-countdown{background:#fff0f0;color:#dc2626;border:1px solid #fecaca;}
.expiry-expired{background:#fee2e2;color:#991b1b;border:1px solid #fca5a5;}
.stats-bar{padding:10px 0;display:flex;justify-content:space-between;font-size:12px;font-weight:600;color:var(--text-secondary);border-top:1px solid #f1f1f1;border-bottom:1px solid #f1f1f1;margin-top:12px;}
.post-actions{display:flex;padding:4px 0;border-bottom:1px solid #f1f1f1;}
.action-btn{flex:1;background:none;border:none;padding:10px 0;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;color:var(--text-secondary);font-size:13px;font-weight:600;transition:0.2s;border-radius:8px;margin:0 2px;font-family:inherit;}
.action-btn:hover,.action-btn:active{background:#f1f5f9;}
.action-btn.liked{color:var(--primary-blue);}
.action-btn svg{width:18px;height:18px;fill:currentColor;}
.cmt-item{display:flex;gap:8px;margin-bottom:10px;position:relative;}
.cmt-avatar{width:30px;height:30px;min-width:30px;border-radius:50%;object-fit:cover;border:1px solid #e2e8f0;cursor:pointer;margin-top:2px;}
.cmt-bubble{flex:1;background:#fff;border:1px solid #e8edf2;border-radius:0 10px 10px 10px;padding:8px 10px;min-width:0;}
.cmt-user{font-weight:700;font-size:12px;color:#0f172a;display:block;margin-bottom:2px;}
.cmt-txt{font-size:13px;color:#334155;line-height:1.4;word-break:break-word;}
.cmt-footer{display:flex;align-items:center;gap:8px;margin-top:5px;}
.cmt-like-btn,.cmt-dislike-btn{display:flex;align-items:center;gap:3px;background:none;border:none;cursor:pointer;font-size:11px;font-weight:600;color:#94a3b8;padding:2px 5px;border-radius:6px;transition:0.15s;}
.cmt-like-btn:hover{background:#f1f5f9;color:#0a66c2;}
.cmt-dislike-btn:hover{background:#f1f5f9;color:#ef4444;}
.cmt-like-btn.active{color:#0a66c2;}
.cmt-dislike-btn.active{color:#ef4444;}
.cmt-like-btn svg,.cmt-dislike-btn svg{width:12px;height:12px;fill:currentColor;}
.cmt-reply-btn{background:none;border:none;cursor:pointer;font-size:11px;font-weight:600;color:#64748b;padding:2px 5px;border-radius:6px;transition:0.15s;}
.cmt-reply-btn:hover{background:#f1f5f9;color:#0a66c2;}
.cmt-3dot{background:none;border:none;cursor:pointer;color:#cbd5e1;padding:2px 4px;border-radius:6px;font-size:14px;line-height:1;margin-left:auto;transition:0.15s;}
.cmt-3dot:hover{background:#f1f5f9;color:#64748b;}
.replies-toggle-btn{display:flex;align-items:center;gap:4px;background:none;border:none;cursor:pointer;font-size:11px;font-weight:700;color:#0a66c2;padding:2px 0;margin-left:38px;margin-bottom:4px;}
.replies-toggle-btn svg{width:12px;height:12px;fill:currentColor;transition:transform 0.2s;}
.replies-toggle-btn.open svg{transform:rotate(180deg);}
.replies-list{margin-left:38px;margin-bottom:4px;}
.reply-item{display:flex;gap:7px;margin-bottom:7px;}
.reply-avatar{width:24px;height:24px;min-width:24px;border-radius:50%;object-fit:cover;border:1px solid #e2e8f0;cursor:pointer;margin-top:2px;}
.reply-bubble{flex:1;background:#f0f7ff;border:1px solid #dbeafe;border-radius:0 10px 10px 10px;padding:6px 9px;}
.reply-input-row{display:flex;gap:6px;margin-left:38px;margin-bottom:6px;align-items:center;}
.reply-input{flex:1;border:1px solid #e2e8f0;border-radius:16px;outline:none;font-size:12px;padding:6px 12px;background:#fff;color:#0f172a;}
.reply-send-btn{background:#0a66c2;color:#fff;border:none;padding:6px 12px;border-radius:14px;font-weight:700;font-size:11px;cursor:pointer;}
.cmt-ctx-menu{position:fixed;background:#fff;border:1px solid #e2e8f0;border-radius:10px;box-shadow:0 6px 20px rgba(0,0,0,0.10);z-index:99999;min-width:140px;overflow:hidden;}
.cmt-ctx-item{display:flex;align-items:center;padding:11px 16px;font-size:13px;font-weight:600;color:#0f172a;cursor:pointer;border-bottom:1px solid #f1f5f9;transition:background 0.12s;}
.cmt-ctx-item:last-child{border-bottom:none;}
.cmt-ctx-item:hover{background:#f8fafc;}
.cmt-ctx-item.danger{color:#ef4444;}
.job-details-table{width:100%;border-collapse:collapse;margin-bottom:25px;border:2px solid #334155;}
.job-details-table td{padding:12px 14px;border:1px solid #94a3b8;font-size:14px;vertical-align:middle;}
.job-details-table .jdt-label{font-weight:700;color:#334155;background:#f8fafc;width:38%;border-right:2px solid #334155;}
.job-details-table .jdt-value{color:#0f172a;font-weight:500;}
.job-details-table tr:first-child td{background:#1e3a5f;color:#fff;font-weight:800;font-size:15px;border-color:#1e3a5f;}
.job-details-table tr:first-child .jdt-label{background:#1e3a5f;color:#fff;border-right:2px solid #fff;}
@media(max-width:480px){.job-title{font-size:20px;}.details-card{padding:18px;}.highlights-box{grid-template-columns:1fr 1fr;}}
.content-col{width:100%;min-width:0;}
.sidebar-col{width:100%;margin-top:0;box-sizing:border-box;}
.page-layout{display:block;width:100%;}
.site-footer{background:#fff;padding:24px 16px 40px;border-top:1px solid #cbd5e1;text-align:center;width:100%;}
.pc-banner{display:none;}
/* max-width:700px applied directly to main */
@media(min-width:1024px){
  .page-layout{display:block;width:100%;position:relative;}
  .pc-banner{display:flex;align-items:flex-start;justify-content:center;width:160px;position:fixed;top:75px;z-index:50;}
  .pc-banner-left{left:max(10px, calc(50% - 350px - 160px - 16px));}
  .pc-banner-right{left:min(calc(100% - 170px), calc(50% + 350px + 16px));}
  .pc-banner.pc-banner-stop{position:absolute;top:var(--pc-stop-top);}
  .pc-banner-inner{width:160px;min-height:600px;overflow:hidden;border-radius:10px;background:#f1f5f9;}
}
</style>
</head>
<body>

<header>
<button class="back-btn" onclick="window.location.href='https://healthjobportal.com/'">
        <svg viewBox="0 0 24 24"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
    </button>
    <div class="logo-text">Post Details</div>
</header>

<div class="page-layout">
<div class="pc-banner pc-banner-left"><div class="pc-banner-inner"><script>atOptions={'key':'12e567a592eb923f9cea953d8fda0594','format':'iframe','height':600,'width':160,'params':{}};</script><script src="https://www.highperformanceformat.com/12e567a592eb923f9cea953d8fda0594/invoke.js"></script></div></div>
<div class="pc-banner pc-banner-right"><div class="pc-banner-inner"><script>atOptions={'key':'12e567a592eb923f9cea953d8fda0594','format':'iframe','height':600,'width':160,'params':{}};</script><script src="https://www.highperformanceformat.com/12e567a592eb923f9cea953d8fda0594/invoke.js"></script></div></div>
<main>
<div class="details-card">
    <div class="user-section">
        <img src="${e(posterPic)}" class="user-avatar" alt="${e(posterName)}"
             onerror="this.src='https://ui-avatars.com/api/?name=${encodeURIComponent(posterName)}&background=0a66c2&color=fff'">
        <div class="user-details">
            <div class="user-name">
                ${e(posterName)}
                <span class="role-badge ${badgeClass}">${roleText}</span>
                ${verified ? '<span style="display:inline-flex;align-items:center;justify-content:center;background:#0a66c2;border-radius:50%;width:18px;height:18px;margin-left:2px;border:2px solid #fff;flex-shrink:0;"><svg viewBox=\"0 0 24 24\" width=\"10\" fill=\"white\"><path d=\"M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z\"/></svg></span>' : ''}
            </div>
            <div class="post-time">${e(city)} &bull; Posted on ${formattedDate}</div>
        </div>
    </div>
${expiresAt ? `<div id="expiry-badge-wrap"></div>` : ""}
<div class="job-title">${e(title)}</div>
<!-- TrustBox widget - Review Collector -->
<div class="trustpilot-widget" data-locale="en-US" data-template-id="56278e9abfbbba0bdcd568bc" data-businessunit-id="6a32028be10624a15deb07d6" data-style-height="52px" data-style-width="100%" data-token="4d97b915-5abc-4d24-9888-b4072d453a26">
  <a href="https://www.trustpilot.com/review/healthjobportal.com" target="_blank" rel="noopener">Trustpilot</a>
</div>
<!-- End TrustBox widget --> 

<div style="width:100%;text-align:center;overflow:hidden;margin:10px 0;">
<script>atOptions={'key':'333dc5bfbee4b34aa13ee95636901b9c','format':'iframe','height':60,'width':468,'params':{}};
<\/script><script src="https://www.highperformanceformat.com/333dc5bfbee4b34aa13ee95636901b9c/invoke.js"><\/script></div>

<table class="job-details-table">
        <tbody>
            <tr>
                <td class="jdt-label">Job Title</td>
                <td class="jdt-value">${e(title)}</td>
            </tr>
            <tr>
                <td class="jdt-label">Category</td>
                <td class="jdt-value">${e(category) || "-"}</td>
            </tr>
            <tr>
                <td class="jdt-label">Location</td>
                <td class="jdt-value">${e(city) || "-"}</td>
            </tr>
            <tr>
                <td class="jdt-label">Salary</td>
                <td class="jdt-value">${e(salary)}</td>
            </tr>
            <tr>
                <td class="jdt-label">Job Shift</td>
                <td class="jdt-value">${e(shift)}</td>
            </tr>
            <tr>
                <td class="jdt-label">Experience</td>
                <td class="jdt-value">${e(experience)}</td>
            </tr>
            <tr>
                <td class="jdt-label">Employment Type</td>
                <td class="jdt-value">${e(empType.replace(/_/g," "))}</td>
            </tr>
            ${expiresAt ? `<tr><td class="jdt-label">Deadline</td><td class="jdt-value">${e(expiresAt)}</td></tr>` : ""}
        </tbody>
    </table>

<div class="desc-title">Detail Description:</div>
<div class="job-desc">${desc}</div>

${extLinkHtml}
${isEmployer ? `<div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:12px;padding:14px 16px;margin:14px 0;display:flex;align-items:center;gap:12px;">
  <span style="font-size:26px;">⚠️</span>
  <div>
    <div style="font-size:13px;font-weight:800;color:#9a3412;margin-bottom:3px;">Stay Safe From Job Fraud</div>
    <div style="font-size:12px;color:#c2410c;line-height:1.55;">Please contact this employer carefully and never pay any money to apply for or accept a job. Health Jobs Portal is not responsible for any fraud, scam, or financial loss related to this post.</div>
  </div>
</div>` : ""}
<!-- CV Maker Promo Note -->
<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:14px 16px;margin:14px 0;display:flex;align-items:center;gap:12px;">
  <span style="font-size:28px;">📄</span>
  <div>
    <div style="font-size:13px;font-weight:700;color:#166534;margin-bottom:3px;">Don't have a CV yet?</div>
    <div style="font-size:12px;color:#15803d;line-height:1.5;">Create a professional CV for free - Click on <a href="https://healthjobportal.com/cv-maker.html" style="color:#166534;font-weight:800;text-decoration:underline;">CV Maker</a></div>
  </div>
</div>
<!-- Share Buttons Row -->
<div style="display:flex;flex-wrap:wrap;gap:8px;margin:12px 0;">
${whatsapp ? `<div onclick="requireAuth(async function(){ await trackClick('${e(postDocId)}','whatsappClicks'); window.open('https://wa.me/${waNumber}?text=${waMsg}','_blank'); })" style="display:inline-flex;align-items:center;gap:6px;padding:8px 14px;background:#25D366;color:white;border-radius:20px;font-size:12px;font-weight:700;cursor:pointer;"><svg width="14" height="14" viewBox="0 0 24 24" fill="white"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51a12.8 12.8 0 0 0-.57-.01c-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z"/></svg>WhatsApp</div>` : ''}
${callNumber ? `<div onclick="requireAuth(async function(){ await trackClick('${e(postDocId)}','callClicks'); window.location.href='tel:${e(callNumber)}'; })"style="display:inline-flex;align-items:center;gap:6px;padding:8px 14px;background:#0078FF;color:white;border-radius:20px;font-size:12px;font-weight:700;cursor:pointer;"><svg width="14" height="14" viewBox="0 0 24 24" fill="white"><path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/></svg>Call</div>` : ''}
<div onclick="openReportPopup()" style="display:inline-flex;align-items:center;gap:4px;padding:5px 10px;background:#fff0f0;color:#ef4444;border:1px solid #fecaca;border-radius:20px;font-size:11px;font-weight:700;cursor:pointer;"><svg width="12" height="12" viewBox="0 0 24 24" fill="#ef4444"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>Report</div>
</div>

${mediaHtml}

${city ? `
<!-- Live Map Section -->
<div style="margin:20px 0;">
    <div style="font-size:14px;font-weight:700;color:var(--text-main);margin-bottom:8px;display:flex;align-items:center;gap:6px;">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="#0a66c2"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>
        Location
    </div>
    <div style="position:relative;width:100%;padding-top:50%;border-radius:12px;overflow:hidden;border:1px solid var(--border-color);cursor:pointer;"
         onclick="window.open('https://www.google.com/maps/search/${encodeURIComponent(address + ', ' + city + ', Pakistan')}','_blank')">
        <iframe
            src="https://maps.google.com/maps?q=${encodeURIComponent(address + ', ' + city + ', Pakistan')}&output=embed&z=13"
            style="position:absolute;top:0;left:0;width:100%;height:100%;border:none;pointer-events:none;"
            loading="lazy"
            allowfullscreen
            referrerpolicy="no-referrer-when-downgrade">
        </iframe>
        <div style="position:absolute;bottom:10px;right:10px;background:rgba(10,102,194,0.9);color:white;padding:7px 12px;border-radius:20px;font-size:12px;font-weight:700;display:flex;align-items:center;gap:5px;">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="white"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>
            Open in Google Maps
        </div>
    </div>
    <div style="font-size:12px;color:var(--text-secondary);margin-top:7px;font-weight:600;">
        📍 ${e(address || city)}, Pakistan
    </div>
</div>
` : ""}

<!-- Share Buttons Row -->
    <!-- Stats Bar -->
    <div class="stats-bar">
        <span id="like-count-display">Loading...</span>
        <span id="cmt-count-display">0 Comments</span>
    </div>

    <!-- Action Buttons -->
    <div class="post-actions">
        <button class="action-btn" id="like-btn" onclick="doLike()">
            <svg viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
            Like
        </button>
        <button class="action-btn" onclick="toggleComments()">
            <svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
            Comment
        </button>
        <button class="action-btn" onclick="sharePost()">
            <svg viewBox="0 0 24 24"><path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z"/></svg>
            Share
        </button>
    </div>

    <!-- Comments Section -->
    <div id="cmt-section" style="display:none;padding:16px;background:#f8fafc;border-top:1px solid #f1f1f1;">
        <div id="cmt-list" style="max-height:300px;overflow-y:auto;margin-bottom:12px;"></div>
        <div style="display:flex;gap:8px;">
            <input type="text" id="cmt-input" placeholder="Add a comment..." style="flex:1;padding:10px 16px;border:1px solid var(--border-color);border-radius:20px;outline:none;font-size:14px;background:#fff;font-family:inherit;">
            <button onclick="sendComment()" style="background:var(--primary-blue);color:#fff;border:none;padding:0 16px;border-radius:20px;font-weight:600;cursor:pointer;font-size:13px;">Post</button>
        </div>
    </div>

</div>

<div style="width:100%;text-align:center;overflow:hidden;margin:12px 0;">
<script>atOptions={'key':'333dc5bfbee4b34aa13ee95636901b9c','format':'iframe','height':60,'width':468,'params':{}};
<\/script><script src="https://www.highperformanceformat.com/333dc5bfbee4b34aa13ee95636901b9c/invoke.js"><\/script></div>

<div class="sidebar-col">
<!-- ── Frequently Asked Questions Section ─────────────────────────────── -->
<div class="faq-section" id="faq-section">
    <div class="faq-heading">
        <svg viewBox="0 0 24 24"><path d="M11 18h2v-2h-2v2zm1-16C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm0-14c-2.21 0-4 1.79-4 4h2c0-1.1.9-2 2-2s2 .9 2 2c0 2-3 1.75-3 5h2c0-2.25 3-2.5 3-5 0-2.21-1.79-4-4-4z"/></svg>
        Frequently Asked Questions
    </div>
    <div class="faq-list" id="faq-list">
        <div class="faq-skeleton"></div>
        <div class="faq-skeleton"></div>
        <div class="faq-skeleton"></div>
        <div class="faq-skeleton"></div>
        <div class="faq-skeleton"></div>
    </div>
</div>
<!-- ── Related Jobs Section ──────────────────────────────────────────── -->
<div class="related-section">
    <div class="related-heading">
        <svg viewBox="0 0 24 24"><path d="M20 6h-2.18c.07-.44.18-.88.18-1.5C18 2.46 15.54 0 12.5 0S7 2.46 7 4.5c0 .62.11 1.06.18 1.5H5C3.9 6 3 6.9 3 8v12c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zM12.5 2C14.43 2 16 3.57 16 5.5c0 .62-.13 1.03-.18 1.5h-6.64c-.05-.47-.18-.88-.18-1.5C9 3.57 10.57 2 12.5 2zM19 20H5V8h14v12z"/></svg>
        Related Jobs
    </div>
    <div class="related-grid" id="related-jobs-grid">
        <div class="related-skeleton"></div>
        <div class="related-skeleton"></div>
        <div class="related-skeleton"></div>
    </div>
</div>
</div>
</main>
</div>
<footer class="site-footer">
    <img src="https://healthjobportal.com/images/logo.png" alt="Health Jobs Portal"
         style="height:28px;object-fit:contain;margin-bottom:6px;opacity:0.8;"
         onerror="this.style.display='none'">
    <p style="font-size:11px;color:#64748b;font-weight:500;margin-bottom:14px;">Pakistan's #1 Digital Healthcare Network</p>
    <div style="display:flex;justify-content:center;flex-wrap:wrap;gap:12px;margin-bottom:12px;">
        <a href="https://healthjobportal.com/index.html" style="color:#64748b;text-decoration:none;font-size:12px;font-weight:600;">Home</a>
        <a href="https://healthjobportal.com/cv-maker.html" style="color:#64748b;text-decoration:none;font-size:12px;font-weight:600;">Cv maker</a>
        <a href="https://healthjobportal.com/about.html" style="color:#64748b;text-decoration:none;font-size:12px;font-weight:600;">About Us</a>
        <a href="https://healthjobportal.com/terms.html" style="color:#64748b;text-decoration:none;font-size:12px;font-weight:600;">Terms</a>
        <a href="https://healthjobportal.com/privcy.html" style="color:#64748b;text-decoration:none;font-size:12px;font-weight:600;">Privacy Policy</a>
    </div>
    <p style="font-size:11px;color:#94a3b8;font-weight:500;">&copy; 2026 Powered by SufianX</p>
</footer>


<!-- Lightbox -->

<div id="lightbox" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.95);z-index:99999;align-items:center;justify-content:center;flex-direction:column;" onclick="closeLightbox()">
    <button style="position:absolute;top:16px;right:16px;background:rgba(255,255,255,0.15);border:none;color:white;width:38px;height:38px;border-radius:50%;font-size:22px;cursor:pointer;display:flex;align-items:center;justify-content:center;">&#x2715;</button>
    <img id="lightbox-img" src="" style="max-width:100vw;max-height:100vh;object-fit:contain;" onclick="event.stopPropagation()">
</div>
<div class="report-popup" id="report-popup">
    <div class="report-top">
        <h3>&#9872; Report this Post</h3>
        <button class="report-close" onclick="closeReport()">&#x2715;</button>
    </div>
    <div class="report-owner-box">
        <img src="${e(posterPic)}"
             onerror="this.src='https://ui-avatars.com/api/?name=${encodeURIComponent(posterName)}&background=0a66c2&color=fff'">
        <div>
            <div style="font-size:13px;font-weight:700;color:#0f172a;">${e(posterName)}</div>
            <div style="font-size:11px;color:#64748b;">Post Owner</div>
        </div>
    </div>
    <div class="report-reasons">
        <div class="reason-chip" onclick="selectReason(this)">Fake Job</div>
        <div class="reason-chip" onclick="selectReason(this)">Scam / Fraud</div>
        <div class="reason-chip" onclick="selectReason(this)">Wrong Info</div>
        <div class="reason-chip" onclick="selectReason(this)">Spam</div>
        <div class="reason-chip" onclick="selectReason(this)">Abusive Content</div>
        <div class="reason-chip" onclick="selectReason(this)">Duplicate Post</div>
        <div class="reason-chip" onclick="selectReason(this)">Other</div>
    </div>
    <input class="report-input" id="report-name" placeholder="Your Name *" maxlength="50">
    <textarea class="report-input" id="report-msg" placeholder="Describe the issue... *" rows="3" style="resize:none;"></textarea>
    <button class="report-submit" onclick="submitReport()">Send Report</button>
    <div class="report-success" id="report-success">&#x2705; Report submitted! We'll review it shortly.</div>
</div>
<script type="module">
import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getFirestore, doc, getDoc, updateDoc, arrayUnion, arrayRemove, collection, query, where, orderBy, onSnapshot, addDoc, deleteDoc, getDocs, serverTimestamp, increment } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const firebaseConfig = {
    apiKey: "AIzaSyD4Cfni7D2Kk_t6qeZ4jcWesIabnSM15mk",
    authDomain: "jobs-45cc9.firebaseapp.com",
    projectId: "jobs-45cc9",
    storageBucket: "jobs-45cc9.firebasestorage.app",
    messagingSenderId: "21065686301",
    appId: "1:21065686301:web:f461ea1b8aabe2fa5895f4"
};
const fireApp = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();
const auth = getAuth(fireApp);
const db = getFirestore(fireApp);
const POST_ID = ${JSON.stringify(post._docId || slug)};
let currentUser = undefined;
let currentUserProfile = null;
let likesArr = [];

window.__authUser = undefined;
onAuthStateChanged(auth, async (user) => {
    currentUser = user;
    window.__authUser = user;
    if (user) {
        try {
            const snap = await getDoc(doc(db, "users", user.uid));
            if (snap.exists()) {
                const d = snap.data();
                const name = d.fullName || d.facilityName || "User";
                currentUserProfile = { name, pic: d.profilePicUrl || "https://ui-avatars.com/api/?name=" + encodeURIComponent(name) };
            }
        } catch(e) {}
    }
    loadLikes();
    loadComments();
});

async function loadLikes() {
    try {
        const snap = await getDoc(doc(db, "posts", POST_ID));
        if (snap.exists()) {
            likesArr = snap.data().likes || [];
            updateLikeUI();
        }
    } catch(e) {}
}

function updateLikeUI() {
    const btn = document.getElementById('like-btn');
    const countEl = document.getElementById('like-count-display');
    const isLiked = !!(currentUser && likesArr.includes(currentUser.uid));
    if (btn) btn.classList.toggle('liked', isLiked);
    if (countEl) countEl.innerText = likesArr.length + " Likes";
}

window.doLike = async function() {
    if (currentUser === undefined) { setTimeout(() => window.doLike(), 200); return; }
    if (!currentUser) { sessionStorage.setItem('redirectAfterLogin', window.location.href); window.location.replace("https://healthjobportal.com/login.html"); return; }
    const isLiked = likesArr.includes(currentUser.uid);
    likesArr = isLiked ? likesArr.filter(id => id !== currentUser.uid) : [...likesArr, currentUser.uid];
    updateLikeUI();
    try {
        const postRef = doc(db, "posts", POST_ID);
        await updateDoc(postRef, { likes: isLiked ? arrayRemove(currentUser.uid) : arrayUnion(currentUser.uid) });
        if (!isLiked) {
            try {
                const postSnap = await getDoc(postRef);
                const ownerId = postSnap.data()?.posterId;
                if (ownerId && ownerId !== currentUser.uid) {
                    await addDoc(collection(db, "notifications"), {
                        toUid: ownerId, fromUid: currentUser.uid,
                        fromName: currentUserProfile?.name || "Someone",
                        fromPic: currentUserProfile?.pic || "",
                        type: "like", postId: POST_ID,
                        postSlug: ${JSON.stringify(slug)},
                        postType: "employer_post",
                        message: "liked your post", createdAt: Date.now(), read: false
                    });
                    fetch("${NOTIFY_API_URL}/api/server", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            toUid: ownerId, fromUid: currentUser.uid,
                            fromName: currentUserProfile?.name || "Someone",
                            type: "like", postId: POST_ID,
                            postSlug: ${JSON.stringify(slug)},
                            message: "liked your post"
                        })
                    }).catch(e => console.error("Notify API error:", e));
                }
            } catch(e) {}
        }
    } catch(e) {}
};

// ── Context Menu ──────────────────────────────────────────────────
window.closeCmtCtxMenu = function() {
    const m = document.getElementById('cmt-ctx-global');
    if (m) m.remove();
};
document.addEventListener('click', window.closeCmtCtxMenu);

function showCmtCtxMenu(e, cid, isMe) {
    window.closeCmtCtxMenu();
    if (!isMe) return;
    e.preventDefault(); e.stopPropagation();
    const menu = document.createElement('div');
    menu.className = 'cmt-ctx-menu';
    menu.id = 'cmt-ctx-global';
    menu.innerHTML = \`
        <div class="cmt-ctx-item" onclick="closeCmtCtxMenu();editCmt('\${cid}')">Edit</div>
        <div class="cmt-ctx-item danger" onclick="closeCmtCtxMenu();deleteCmt('\${cid}')">Delete</div>\`;
const btn = e.target.closest('button') || e.target;
const rect = btn.getBoundingClientRect();
const menuW = 150, menuH = 80;
let left = rect.left;
let top = rect.top - menuH - 8;
if (left + menuW > window.innerWidth) left = window.innerWidth - menuW - 8;
if (top < 8) top = rect.bottom + 8;
menu.style.left = left + 'px';
menu.style.top  = top + 'px';
    document.body.appendChild(menu);
    setTimeout(() => document.addEventListener('click', window.closeCmtCtxMenu, { once: true }), 50);
}

// ── Comment Reactions ─────────────────────────────────────────────
window.toggleCmtReaction = async function(cid, type) {
    if (!currentUser) { sessionStorage.setItem('redirectAfterLogin', window.location.href); window.location.replace("https://healthjobportal.com/login.html"); return; }
    const uid = currentUser.uid;
    const lBtn   = document.getElementById('lbtn-' + cid);
    const dBtn   = document.getElementById('dbtn-' + cid);
    const lCount = document.getElementById('lcount-' + cid);
    const dCount = document.getElementById('dcount-' + cid);
    const wasLiked    = lBtn?.classList.contains('active');
    const wasDisliked = dBtn?.classList.contains('active');
    if (type === 'like') {
        lBtn?.classList.toggle('active', !wasLiked);
        dBtn?.classList.remove('active');
        if (lCount) lCount.innerText = !wasLiked ? (parseInt(lCount.innerText||'0')+1)||1 : Math.max(0,parseInt(lCount.innerText||'1')-1)||'';
        if (wasDisliked && dCount) dCount.innerText = Math.max(0,parseInt(dCount.innerText||'1')-1)||'';
    } else {
        dBtn?.classList.toggle('active', !wasDisliked);
        lBtn?.classList.remove('active');
        if (dCount) dCount.innerText = !wasDisliked ? (parseInt(dCount.innerText||'0')+1)||1 : Math.max(0,parseInt(dCount.innerText||'1')-1)||'';
        if (wasLiked && lCount) lCount.innerText = Math.max(0,parseInt(lCount.innerText||'1')-1)||'';
    }
    try {
        const cmtRef = doc(db, "posts", POST_ID, "comments", cid);
        const snap = await getDoc(cmtRef);
        if (!snap.exists()) return;
        const data = snap.data();
        let likes    = data.likes    || [];
        let dislikes = data.dislikes || [];
        if (type === 'like') {
            likes    = likes.includes(uid) ? likes.filter(u => u !== uid) : [...likes, uid];
            dislikes = dislikes.filter(u => u !== uid);
        } else {
            dislikes = dislikes.includes(uid) ? dislikes.filter(u => u !== uid) : [...dislikes, uid];
            likes    = likes.filter(u => u !== uid);
        }
        await updateDoc(cmtRef, { likes, dislikes });
    } catch(e) {}
};

// ── Reply Box ─────────────────────────────────────────────────────
window.showReplyBox = function(parentCid, toName) {
    document.querySelectorAll('.reply-input-row').forEach(b => b.remove());
    const row = document.createElement('div');
    row.className = 'reply-input-row';
    row.id = 'reply-row-' + parentCid;
    row.innerHTML = \`
        <input class="reply-input" id="reply-in-\${parentCid}" placeholder="Reply to \${escHtml(toName)}..." maxlength="300">
<button class="reply-send-btn" onclick="sendReply('\${parentCid}')" style="white-space:nowrap;flex-shrink:0;padding:6px 10px;font-size:11px;">Send</button>\`;
    const cmtItem = document.getElementById('cmt-item-' + parentCid);
    if (cmtItem) cmtItem.after(row);
    document.getElementById('reply-in-' + parentCid)?.focus();
};

window.sendReply = async function(parentCid) {
    if (!currentUser) { sessionStorage.setItem('redirectAfterLogin', window.location.href); window.location.replace("https://healthjobportal.com/login.html"); return; }
    const inp = document.getElementById('reply-in-' + parentCid);
    if (!inp) return;
    const text = inp.value.trim();
    if (!text) return;
    inp.disabled = true;
    const name = currentUserProfile?.name || "User";
    const pic  = currentUserProfile?.pic  || "https://ui-avatars.com/api/?name=" + encodeURIComponent(name);
    try {
        await addDoc(collection(db, "posts", POST_ID, "comments"), {
            text, userId: currentUser.uid, userName: name, userPic: pic,
            parentId: parentCid, createdAt: serverTimestamp()
        });
        await updateDoc(doc(db, "posts", POST_ID), { commentsCount: increment(1) });
        document.getElementById('reply-row-' + parentCid)?.remove();
    } catch(e) { inp.disabled = false; }
};

// ── Toggle Replies ────────────────────────────────────────────────
window.toggleReplies = function(parentCid) {
    const list = document.getElementById('replies-list-' + parentCid);
    const btn  = document.getElementById('replies-toggle-' + parentCid);
    if (!list || !btn) return;
    const isOpen = list.style.display !== 'none';
    list.style.display = isOpen ? 'none' : 'block';
    btn.classList.toggle('open', !isOpen);
};

// ── Build Comment Element ─────────────────────────────────────────
function buildCmtEl(c, isReply) {
    const isMe   = !!(currentUser && c.userId === currentUser.uid);
    const myUid  = currentUser?.uid || '';
    const pic    = c.userPic || "https://ui-avatars.com/api/?name=" + encodeURIComponent(c.userName||'U');
    const likes    = Array.isArray(c.likes)    ? c.likes    : [];
    const dislikes = Array.isArray(c.dislikes) ? c.dislikes : [];
    const lCount = likes.length;
    const dCount = dislikes.length;
    const iL = likes.includes(myUid);
    const iD = dislikes.includes(myUid);

    const wrap = document.createElement('div');
    wrap.id = 'cmt-item-' + c.id;
    wrap.className = isReply ? 'reply-item' : 'cmt-item';

    const avatarClass  = isReply ? 'reply-avatar' : 'cmt-avatar';
    const bubbleClass  = isReply ? 'reply-bubble'  : 'cmt-bubble';

    wrap.innerHTML = \`
        <img src="\${pic}" class="\${avatarClass}"
            onclick="location.href='https://healthjobportal.com/wid.html?uid=\${c.userId}'"
            onerror="this.src='https://ui-avatars.com/api/?name=U'">
        <div class="\${bubbleClass}">
            <span class="cmt-user">\${escHtml(c.userName || 'User')}</span>
            <div class="cmt-txt" id="txt-\${c.id}">\${escHtml(c.text)}</div>
            <div class="cmt-footer">
                <button class="cmt-like-btn \${iL?'active':''}" id="lbtn-\${c.id}"
                    onclick="window.toggleCmtReaction('\${c.id}','like')">
                    <svg viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
                    <span id="lcount-\${c.id}">\${lCount > 0 ? lCount : ''}</span>
                </button>
                <button class="cmt-dislike-btn \${iD?'active':''}" id="dbtn-\${c.id}"
                    onclick="window.toggleCmtReaction('\${c.id}','dislike')">
                    <svg viewBox="0 0 24 24"><path d="M15 3H6c-.83 0-1.54.5-1.84 1.22l-3.02 7.05c-.09.23-.14.47-.14.73v2c0 1.1.9 2 2 2h6.31l-.95 4.57-.03.32c0 .41.17.79.44 1.06L9.83 23l6.59-6.59c.36-.36.58-.86.58-1.41V5c0-1.1-.9-2-2-2zm4 0v12h4V3h-4z"/></svg>
                    <span id="dcount-\${c.id}">\${dCount > 0 ? dCount : ''}</span>
                </button>
                \${!isReply ? \`<button class="cmt-reply-btn" onclick="window.showReplyBox('\${c.id}','\${escHtml(c.userName||'User')}')">Reply</button>\` : ''}
                \${isMe ? \`<button class="cmt-3dot" onclick="event.stopPropagation();showCmtCtxMenu(event,'\${c.id}',true)">···</button>\` : ''}
            </div>
        </div>\`;

    if (isMe) {
        let pressTimer;
        wrap.addEventListener('touchstart', (e) => { pressTimer = setTimeout(() => showCmtCtxMenu(e, c.id, true), 600); }, { passive: true });
        wrap.addEventListener('touchend',  () => clearTimeout(pressTimer));
        wrap.addEventListener('touchmove', () => clearTimeout(pressTimer));
    }
    return wrap;
}

// ── Load Comments ─────────────────────────────────────────────────
function loadComments() {
    const cmtList = document.getElementById('cmt-list');
    const countEl = document.getElementById('cmt-count-display');
    if (!cmtList) return;
    const q = query(collection(db, "posts", POST_ID, "comments"), orderBy("createdAt", "asc"));
    onSnapshot(q, (snap) => {
        if (countEl) countEl.innerText = snap.size + " Comments";
        const allCmts = [];
        snap.forEach(d => {
            const c = d.data();
            allCmts.push({ id: d.id, ...c });
        });
        const topLevel   = allCmts.filter(c => !c.parentId);
        const repliesMap = {};
        allCmts.filter(c => c.parentId).forEach(r => {
            if (!repliesMap[r.parentId]) repliesMap[r.parentId] = [];
            repliesMap[r.parentId].push(r);
        });
        cmtList.innerHTML = '';
        topLevel.forEach(c => {
            cmtList.appendChild(buildCmtEl(c, false));
            const myReplies = repliesMap[c.id] || [];
            if (myReplies.length > 0) {
                const togBtn = document.createElement('button');
                togBtn.className = 'replies-toggle-btn';
                togBtn.id = 'replies-toggle-' + c.id;
                togBtn.innerHTML = \`<svg viewBox="0 0 24 24"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg> \${myReplies.length} \${myReplies.length===1?'Reply':'Replies'}\`;
                togBtn.onclick = () => window.toggleReplies(c.id);
                cmtList.appendChild(togBtn);
                const replList = document.createElement('div');
                replList.className = 'replies-list';
                replList.id = 'replies-list-' + c.id;
                replList.style.display = 'none';
                myReplies.forEach(r => replList.appendChild(buildCmtEl(r, true)));
                cmtList.appendChild(replList);
            }
        });
        if (topLevel.length === 0) cmtList.innerHTML = '<div style="text-align:center;padding:16px;color:#94a3b8;font-size:12px;">No comments yet. Be first!</div>';
        cmtList.scrollTop = cmtList.scrollHeight;
    });
}

window.toggleComments = function() {
    if (currentUser === undefined) { let w=0; const iv=setInterval(()=>{ w+=100; if(currentUser!==undefined){ clearInterval(iv); if(currentUser) _openComments(); else { sessionStorage.setItem('redirectAfterLogin',window.location.href); window.location.replace("https://healthjobportal.com/login.html"); } } if(w>5000){ clearInterval(iv); window.location.replace("https://healthjobportal.com/login.html"); } },100); return; }
    if (!currentUser) { sessionStorage.setItem('redirectAfterLogin', window.location.href); window.location.replace("https://healthjobportal.com/login.html"); return; }
    _openComments();
};
function _openComments() {
    const section = document.getElementById('cmt-section');
    if (!section) return;
    const open = section.style.display === 'block';
    section.style.display = open ? 'none' : 'block';
    if (!open) { const inp = document.getElementById('cmt-input'); if (inp) inp.focus(); }
}

window.sendComment = async function() {
    if (currentUser === undefined) { setTimeout(() => window.sendComment(), 200); return; }
    if (!currentUser) { sessionStorage.setItem('redirectAfterLogin', window.location.href); window.location.replace("https://healthjobportal.com/login.html"); return; }
    const inp = document.getElementById('cmt-input');
    if (!inp || !inp.value.trim()) return;
    const text = inp.value.trim();
    inp.value = "";
    const name = currentUserProfile?.name || "User";
    const pic = currentUserProfile?.pic || "https://ui-avatars.com/api/?name=" + encodeURIComponent(name);
    try {
        await addDoc(collection(db, "posts", POST_ID, "comments"), { text, userId: currentUser.uid, userName: name, userPic: pic, createdAt: serverTimestamp() });
        await updateDoc(doc(db, "posts", POST_ID), { commentsCount: increment(1) });
        try {
            const postSnap = await getDoc(doc(db, "posts", POST_ID));
            const ownerId = postSnap.data()?.posterId;
            if (ownerId && ownerId !== currentUser.uid) {
                await addDoc(collection(db, "notifications"), {
                    toUid: ownerId, fromUid: currentUser.uid,
                    fromName: currentUserProfile?.name || "Someone",
                    fromPic: currentUserProfile?.pic || "",
                    type: "comment", postId: POST_ID,
                    postSlug: ${JSON.stringify(slug)},
                    postType: "employer_post",
                    message: "commented on your post", createdAt: Date.now(), read: false
                });
                fetch("${NOTIFY_API_URL}/api/server", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        toUid: ownerId, fromUid: currentUser.uid,
                        fromName: currentUserProfile?.name || "Someone",
                        type: "comment", postId: POST_ID,
                        postSlug: ${JSON.stringify(slug)},
                        message: "commented on your post"
                    })
                }).catch(e => console.error("Notify API error:", e));
            }
        } catch(e) {}
    } catch(e) { inp.value = text; }
};

window.deleteCmt = async function(cmtId) {
    if (!currentUser || !confirm("Delete this comment?")) return;
    try {
        await deleteDoc(doc(db, "posts", POST_ID, "comments", cmtId));
        await updateDoc(doc(db, "posts", POST_ID), { commentsCount: increment(-1) });
    } catch(e) {}
};

window.editCmt = async function(cmtId) {
    const txtEl = document.getElementById('txt-' + cmtId);
    if (!txtEl) return;
    const old = txtEl.innerText;
    const nt = prompt("Edit comment:", old);
    if (nt && nt !== old) await updateDoc(doc(db, "posts", POST_ID, "comments", cmtId), { text: nt.trim() });
};

function escHtml(s) {
    return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

document.addEventListener('DOMContentLoaded', () => {
    const inp = document.getElementById('cmt-input');
    if (inp) inp.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); window.sendComment(); } });
});
<\/script>
<script src="https://cdn.jsdelivr.net/npm/@emailjs/browser@4/dist/email.min.js"><\/script>
<script>
emailjs.init('Rr88IrZ8s69Qyj8DS');

function requireAuth(action) {
    if (window.__authUser === undefined) {
        let waited = 0;
        const interval = setInterval(() => {
            waited += 100;
            if (window.__authUser !== undefined) {
                clearInterval(interval);
                if (window.__authUser) {
                    action();
                } else {
                    sessionStorage.setItem('redirectAfterLogin', window.location.href);
                    window.location.replace("https://healthjobportal.com/login.html");
                }
            }
if (waited > 8000) {
                clearInterval(interval);
                sessionStorage.setItem('redirectAfterLogin', window.location.href);
                window.location.replace("https://healthjobportal.com/login.html");
            }
        }, 100);
    } else if (window.__authUser) {
        action();
    } else {
        sessionStorage.setItem('redirectAfterLogin', window.location.href);
        window.location.replace("https://healthjobportal.com/login.html");
    }
}

async function trackClick(postId, field) {
    try {
        await fetch('/api/track', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ postId, field, collection: 'posts' })
        });
    } catch(e) { console.log('Track error:', e); }
}

async function loadRelatedUpdates() {
    const list = document.getElementById('related-updates-list');
    if (!list) return;
    const CURRENT_SLUG = ${JSON.stringify(slug)};
    const daySeed = Math.floor(Date.now() / 86400000);
    function seededShuffle(arr, seed) {
        const a = [...arr]; let s = seed;
        for (let i = a.length-1; i > 0; i--) {
            s = (s * 1664525 + 1013904223) & 0xffffffff;
            const j = Math.abs(s) % (i+1);
            [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
    }
    try {
        const res = await fetch('/api/related-updates-pool');
        const pool = await res.json();
        const filtered = seededShuffle(
            pool.filter(p => p.slug !== CURRENT_SLUG), daySeed
        ).slice(0, 5);
        if (!filtered.length) {
            list.innerHTML = '<p style="font-size:13px;color:#94a3b8;text-align:center;padding:14px 0;">No related updates found.</p>';
            return;
        }
        list.innerHTML = filtered.map(p => {
            const pPic = p.posterPic || \`https://ui-avatars.com/api/?name=U&background=16a34a&color=fff\`;
            const thumb = p.thumb || pPic;
            return \`<a class="rel-card" href="/updates/\${p.slug}">
                <img class="rel-thumb" src="\${thumb}" onerror="this.src='\${pPic}'" alt="" loading="lazy">
                <div class="rel-info">
                    <div class="rel-title">\${(p.title||p.desc||'').replace(/</g,'&lt;')}</div>
                    <div class="rel-meta">
                        <span class="rel-badge">🩺 Update</span>
                        \${p.location ? '<span>📍 '+p.location+'</span>' : ''}
                    </div>
                </div>
                <svg class="rel-arrow" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z"/></svg>
            </a>\`;
        }).join('');
    } catch(err) {
        list.innerHTML = '';
        console.log('Related updates error:', err);
    }
}
async function trackView(postId) {
    try {
        const uid = window.__authUser?.uid || ('guest_' + Math.random().toString(36).substr(2,9));
        const key = 'viewed_' + postId + '_' + uid;
        if (localStorage.getItem(key)) return;
        localStorage.setItem(key, '1');
        await fetch('/api/track', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ postId, field: 'views', collection: 'posts' })
        });
    } catch(e) { console.log('View track error:', e); }
}
window.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => trackView(${JSON.stringify(slug)}), 2000);
    loadRelatedJobs();
    loadFaqQuestions();
});

// ── Related Jobs Loader ──────────────────────────────────────────────────────
async function loadRelatedJobs() {
    const grid = document.getElementById('related-jobs-grid');
    if (!grid) return;
    const CURRENT_SLUG = ${JSON.stringify(slug)};
    const daySeed = Math.floor(Date.now() / 86400000);

    function seededShuffle(arr, seed) {
        const a = [...arr]; let s = seed;
        for (let i = a.length-1; i > 0; i--) {
            s = (s * 1664525 + 1013904223) & 0xffffffff;
            const j = Math.abs(s) % (i+1);
            [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
    }

    try {
        const res = await fetch('/api/related-jobs-pool');
        const pool = await res.json();
        const filtered = seededShuffle(
            pool.filter(p => p.id !== CURRENT_SLUG), daySeed
        ).slice(0, 5);

        if (!filtered.length) {
            grid.innerHTML = '<p style="font-size:13px;color:#94a3b8;text-align:center;padding:14px 0;">No related jobs found.</p>';
            return;
        }

        grid.innerHTML = filtered.map(p => {
            const isEmp = p.posterRole === "employer";
            const pPic = p.posterPic || \`https://ui-avatars.com/api/?name=\${encodeURIComponent(p.posterName||'U')}&background=0a66c2&color=fff\`;
            const thumb = p.thumb || pPic;
            return \`<a class="related-card" href="/jobs/\${p.id}">
                <img class="related-thumb" src="\${thumb}" onerror="this.src='\${pPic}'" alt="" loading="lazy">
                <div class="related-info">
                    <div class="related-title">\${p.title.replace(/</g,'&lt;')}</div>
                    <div class="related-meta">
                        <span class="related-badge \${isEmp?'emp':'cnd'}">\${isEmp?'Hiring':'Candidate'}</span>
                        \${p.location?'<span>📍 '+p.location+'</span>':""}
                        \${p.salary?'<span>&middot; '+p.salary+'</span>':""}
                    </div>
                </div>
                <svg class="related-arrow" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z"/></svg>
            </a>\`;
        }).join("");
    } catch(err) {
        grid.innerHTML = '';
        console.log('Related jobs error:', err);
    }
}

// ── Related Questions (FAQ) ───────────────────────────────────────────────
window._faqApiUrl = '${FAQ_CHAT_API_URL}';
window._faqPostTitle  = ${JSON.stringify(title)};
window._faqPostDesc   = ${JSON.stringify(desc.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 500))};
window._faqQuestions  = [];
window._faqCache      = {};

function faqBuildContext() {
    return 'Post title: "' + window._faqPostTitle + '"\\nPost description: "' + window._faqPostDesc + '"\\n\\n';
}

function faqParseQuestionsReply(text) {
    try {
        var t = String(text || '').trim();
        t = t.replace(/^\`\`\`json\s*/i, '').replace(/^\`\`\`\s*/, '').replace(/\`\`\`\s*$/, '').trim();
        var match = t.match(/\[[\s\S]*\]/);
        var arr = JSON.parse(match ? match[0] : t);
        return Array.isArray(arr) ? arr.filter(function(q){ return typeof q === 'string' && q.trim(); }).map(function(q){ return q.trim(); }) : [];
    } catch(e) {
        return [];
    }
}

async function faqAskChat(prompt) {
    // First try hacker-chat API
    var controller = new AbortController();
    var timer = setTimeout(function(){ controller.abort(); }, 25000);
    try {
        var res = await fetch(window._faqApiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: prompt }),
            signal: controller.signal
        });
        clearTimeout(timer);
        var data = await res.json();
        if (res.ok) {
            // Try all common reply field names
            var reply = (data && (data.reply || data.text || data.content || data.answer || data.result || data.output || data.message)) || '';
            if (reply && typeof reply === 'object') reply = JSON.stringify(reply);
            if (reply && String(reply).trim()) return String(reply);
        }
    } catch(e1) {
        clearTimeout(timer);
    }
    // Fallback: Anthropic API directly
    var controller2 = new AbortController();
    var timer2 = setTimeout(function(){ controller2.abort(); }, 30000);
    try {
        var res2 = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'anthropic-version': '2023-06-01',
                'anthropic-dangerous-direct-browser-access': 'true'
            },
            body: JSON.stringify({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 500,
                messages: [{ role: 'user', content: prompt }]
            }),
            signal: controller2.signal
        });
        clearTimeout(timer2);
        var data2 = await res2.json();
        if (!res2.ok) throw new Error('Anthropic API error ' + res2.status);
        var block = (data2.content || []).find(function(b){ return b.type === 'text'; });
        return (block && block.text) || '';
    } catch(e2) {
        clearTimeout(timer2);
        throw e2;
    }
}

async function loadFaqQuestions(attempt) {
    attempt = attempt || 1;
    var list = document.getElementById('faq-list');
    if (!list) return;
    try {
        var prompt = faqBuildContext() +
            'Generate exactly 5 short FAQ questions a visitor might ask about this job post. ' +
            'Return ONLY a JSON array of 5 question strings, no markdown, no extra text.';
        var reply = await faqAskChat(prompt);
        window._faqQuestions = faqParseQuestionsReply(reply).slice(0, 5);

        if (!window._faqQuestions.length) {
            throw new Error('Empty FAQ list from API');
        }

        list.innerHTML = window._faqQuestions.map(function(q, i) {
            var safeQ = String(q).replace(/</g, '&lt;');
            return '<div class="faq-item" id="faq-item-' + i + '">' +
                '<div class="faq-question" onclick="toggleFaqItem(' + i + ')">' +
                '<span>' + safeQ + '</span>' +
                '<svg class="faq-chevron" viewBox="0 0 24 24" fill="currentColor"><path d="M7 10l5 5 5-5z"/></svg>' +
                '</div>' +
                '<div class="faq-answer" id="faq-answer-' + i + '">' +
                '<div class="faq-answer-inner" id="faq-answer-inner-' + i + '"></div>' +
                '</div>' +
                '</div>';
        }).join('');
    } catch(err) {
        console.log('FAQ questions error (attempt ' + attempt + '):', err);
        // Retry a couple of times before giving up — the FAQ backend can be
        // slow to wake up or briefly time out, so one failed attempt should
        // not permanently remove the section after the user has already
        // seen the loading skeletons.
        if (attempt < 3) {
            setTimeout(function() { loadFaqQuestions(attempt + 1); }, 1500 * attempt);
            return;
        }
        var sec = document.getElementById('faq-section');
        if (sec) sec.remove();
    }
}

window.toggleFaqItem = async function(i) {
    var item   = document.getElementById('faq-item-' + i);
    var answer = document.getElementById('faq-answer-' + i);
    var inner  = document.getElementById('faq-answer-inner-' + i);
    if (!item || !answer || !inner) return;
    var isOpen = item.classList.contains('open');

    document.querySelectorAll('.faq-item.open').forEach(function(el) {
        if (el !== item) {
            el.classList.remove('open');
            el.querySelector('.faq-answer').style.maxHeight = '0px';
        }
    });

    if (isOpen) {
        item.classList.remove('open');
        answer.style.maxHeight = '0px';
        setTimeout(repositionWaButton, 260);
        return;
    }

    item.classList.add('open');

    if (window._faqCache[i]) {
        inner.innerHTML = window._faqCache[i];
        answer.style.maxHeight = answer.scrollHeight + 'px';
        setTimeout(repositionWaButton, 260);
        return;
    }

    inner.innerHTML = '<div class="faq-answer-skeleton" style="width:95%"></div><div class="faq-answer-skeleton" style="width:80%"></div><div class="faq-answer-skeleton" style="width:55%"></div>';
    answer.style.maxHeight = '90px';
    setTimeout(repositionWaButton, 260);

    try {
        var question = window._faqQuestions[i] || '';
        var prompt = faqBuildContext() +
            'Question: "' + question + '"\\n\\n' +
            'Answer this question briefly and helpfully for a visitor of the Health Jobs Portal.';
        var reply = await faqAskChat(prompt);
        var safe = String(reply || 'Sorry, no answer is available right now.').replace(/</g, '&lt;');
        window._faqCache[i] = safe;
        inner.innerHTML = safe;
    } catch(err) {
        inner.innerHTML = 'Could not load the answer. Please try again.';
        console.log('FAQ answer error:', err);
    } finally {
        answer.style.maxHeight = answer.scrollHeight + 'px';
        setTimeout(repositionWaButton, 260);
    }
};

// keep the WhatsApp floating button below any open FAQ answer box
function repositionWaButton() {
    const btn = document.getElementById('wa-channel-btn');
    if (!btn) return;
    const openItem = document.querySelector('.faq-item.open');
    if (!openItem) {
        btn.style.top = '';
        btn.style.bottom = '90px';
        return;
    }
    const rect = openItem.getBoundingClientRect();
    const newTop = rect.bottom + 12;
    if (newTop < 0 || newTop + 60 > window.innerHeight) {
        btn.style.top = '';
        btn.style.bottom = '90px';
    } else {
        btn.style.bottom = '';
        btn.style.top = newTop + 'px';
    }
}

const REPORT_DATA = {
    ownerName: ${JSON.stringify(posterName)},
    postTitle: ${JSON.stringify(title)},
    postId:    ${JSON.stringify(slug)},
    postUrl:   ${JSON.stringify(canonicalUrl)}
};
let selectedReason = '';
window.openLightbox = function(url){
    const lb = document.getElementById('lightbox');
    document.getElementById('lightbox-img').src = url;
    lb.style.display = 'flex';
    document.body.style.overflow = 'hidden';
}
window.closeLightbox = function(){
    document.getElementById('lightbox').style.display = 'none';
    document.body.style.overflow = '';
}
document.addEventListener('keydown', e => { if(e.key === 'Escape') closeLightbox(); });
(function(){
    const expiresAt = ${JSON.stringify(expiresAt || "")};
    if (!expiresAt) return;
    const wrap = document.getElementById('expiry-badge-wrap');
    if (!wrap) return;
    function update() {
        const now = Date.now();
        const exp = new Date(expiresAt).getTime();
        const diff = exp - now;
        if (diff <= 0) {
            wrap.innerHTML = '<span class="expiry-badge expiry-expired">Expired</span>';
            return;
        }
        const hours = Math.floor(diff / 3600000);
        const mins = Math.floor((diff % 3600000) / 60000);
        const secs = Math.floor((diff % 60000) / 1000);
        if (diff <= 86400000) {
            wrap.innerHTML = \`<span class="expiry-badge expiry-countdown">Expires in: \${String(hours).padStart(2,'0')}:\${String(mins).padStart(2,'0')}:\${String(secs).padStart(2,'0')}</span>\`;
            setTimeout(update, 1000);
        }
    }
    update();
})();

function sharePost(){
    if(navigator.share){
        navigator.share({ title: ${JSON.stringify(title)}, url: ${JSON.stringify(canonicalUrl)} });
    } else {
        navigator.clipboard.writeText(${JSON.stringify(canonicalUrl)});
        alert('Link copied to clipboard!');
    }
}
function openReportPopup(){ document.getElementById('report-popup').classList.add('show'); }
function closeReport(){ document.getElementById('report-popup').classList.remove('show'); }
function selectReason(el){
    document.querySelectorAll('.reason-chip').forEach(c => c.classList.remove('selected'));
    el.classList.add('selected');
    selectedReason = el.innerText;
}
async function submitReport(){
    const name = document.getElementById('report-name').value.trim();
    const msg  = document.getElementById('report-msg').value.trim();
    if(!selectedReason){ alert('Please select a reason.'); return; }
    if(!name){ alert('Please enter your name.'); return; }
    if(!msg){ alert('Please describe the issue.'); return; }
    const btn = document.querySelector('.report-submit');
    btn.innerText = 'Sending...'; btn.disabled = true;
    try {
        await emailjs.send('service_gnjsdvm', 'template_bus1179', {
            reporter_name: name,
            reason:        selectedReason,
            message:       msg,
            post_owner:    REPORT_DATA.ownerName,
            post_title:    REPORT_DATA.postTitle,
            post_id:       REPORT_DATA.postId,
            post_url:      REPORT_DATA.postUrl
        });
        btn.style.display = 'none';
        document.getElementById('report-success').style.display = 'block';
        setTimeout(() => closeReport(), 3000);
    } catch(err) {
        alert('Error sending report. Try again.');
        btn.innerText = 'Send Report';
        btn.disabled  = false;
    }
}
<\/script>
<script>
(function(){
  function pcBannerStop(){
    var footer = document.querySelector('.site-footer');
    var layout = document.querySelector('.page-layout');
    var banners = document.querySelectorAll('.pc-banner');
    if (!footer || !layout || !banners.length) return;
    var layoutRect = layout.getBoundingClientRect();
    var footerRect = footer.getBoundingClientRect();
    var bannerH = 600;
    var topOffset = 75;
    var hitsFooter = footerRect.top <= topOffset + bannerH;
    banners.forEach(function(b){
      if (hitsFooter) {
        var stopTop = (footerRect.top - layoutRect.top) - bannerH - 10;
        b.style.setProperty('--pc-stop-top', stopTop + 'px');
        b.classList.add('pc-banner-stop');
      } else {
        b.classList.remove('pc-banner-stop');
      }
    });
  }
  window.addEventListener('scroll', pcBannerStop, { passive: true });
  window.addEventListener('resize', pcBannerStop);
  document.addEventListener('DOMContentLoaded', pcBannerStop);
  setTimeout(pcBannerStop, 300);
})();
<\/script>
<!-- WhatsApp Channel Float Button -->
<div id="wa-channel-btn" onclick="window.open('https://whatsapp.com/channel/0029VbCe3Mf2kNFroj9qx223','_blank')" style="position:fixed;bottom:90px;right:16px;z-index:9998;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:4px;animation:waBounce 2s ease-in-out infinite;">
  <div style="background:#25D366;width:54px;height:54px;border-radius:50%;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 14px rgba(37,211,102,0.5);">
    <svg width="28" height="28" viewBox="0 0 24 24" fill="white"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51a12.8 12.8 0 0 0-.57-.01c-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z"/></svg>
  </div>
  <div style="background:#25D366;color:white;font-size:9px;font-weight:800;padding:3px 8px;border-radius:10px;white-space:nowrap;box-shadow:0 2px 8px rgba(37,211,102,0.4);">Join our<br>WhatsApp Channel</div>
</div>
<style>
@keyframes waBounce {
  0%, 100% { transform: translateY(0px); }
  50% { transform: translateY(-8px); }
}
</style>
</body>
</html>`;
}

// ── General Update Page Builder ───────────────────────────────────────────────
function buildUpdatePage(post, slug, verified = false) {
    const e  = s => String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
    const eJ = s => String(s ?? "").replace(/\\/g,"\\\\").replace(/"/g,'\\"').replace(/\n/g,"\\n");
    const nl = s => e(s).replace(/\n/g,"<br>");

    const title      = post.title      || "Medical Update";
    const desc       = post.desc       || "";
    const posterName = post.posterName || SITE_NAME;
    const posterPic  = post.posterPic  || `https://ui-avatars.com/api/?name=${encodeURIComponent(posterName)}&background=0a66c2&color=fff`;
    const posterId   = post.posterId   || "";
    const city       = post.location   || "Pakistan";
    const extLink    = post.externalLink || "";
    const postedDate = post.postedDateISO || post.createdAt || "";
    const media      = Array.isArray(post.media) ? post.media : [];
    const canonicalUrl = `${SITE_URL}/updates/${slug}`;
    const postDocId = post._docId || slug;

    const pageTitle = title
        ? `${title} | ${SITE_NAME}`
        : `Medical Update by ${posterName} | ${SITE_NAME}`;
    const tempDesc = desc.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

const metaDesc = tempDesc.substring(0, 157) + (tempDesc.length > 157 ? "..." : "");
    const ogImage   = media.find(m => m.type === "image")?.url || posterPic || FALLBACK_IMG;

    let formattedDate = "Recently";
    if (postedDate) {
        try {
            formattedDate = new Date(postedDate).toLocaleDateString("en-US", {
                day: "numeric", month: "short", year: "numeric"
            });
        } catch(_) {}
    }

    const specialties = ["Internal Medicine","Emergency Medicine","General Practice","Healthcare News"];
const jsonLd = JSON.stringify({
    "@context": "https://schema.org/",
    "@graph": [
        {
            "@type": ["NewsArticle", "MedicalWebPage"],
            "headline": title || desc.substring(0, 110),
            "description": metaDesc,
            "datePublished": postedDate || new Date().toISOString(),
            "dateModified": postedDate || new Date().toISOString(),
            "author": {
                "@type": "Person",
                "name": posterName,
                "image": posterPic
            },
            "publisher": {
                "@type": "Organization",
                "name": SITE_NAME,
                "logo": {
                    "@type": "ImageObject",
                    "url": FALLBACK_IMG
                }
            },
            "image": {
                "@type": "ImageObject",
                "url": ogImage,
                "width": 1200,
                "height": 630
            },
            "url": canonicalUrl,
            "mainEntityOfPage": {
                "@type": "WebPage",
                "@id": canonicalUrl
            },
            "articleSection": "Medical News",
            "keywords": "medical news Pakistan, healthcare update, clinical update, " + posterName + ", " + city,
            "about": {
                "@type": "MedicalCondition",
                "name": title || "Medical Update"
            },
            "specialty": {
                "@type": "MedicalSpecialty",
                "name": "General Practice"
            },
            "medicalAudience": {
                "@type": "MedicalAudience",
                "audienceType": "Clinician"
            },
            "inLanguage": "en-PK",
            "isAccessibleForFree": true
        }
    ]
});

    let mediaHtml = "";
    if (media.length > 0) {
        mediaHtml = '<div class="media-container">' + media.map(m => {
if (m.type === "image") return `<div class="media-item"><img src="${e(m.url)}" alt="${e(title || posterName)}" loading="lazy" onclick="openLightbox('${e(m.url)}')" style="cursor:zoom-in;"></div>`;
            if (m.type === "video") return `<div class="media-item"><video src="${e(m.url)}" controls preload="none" style="width:100%;border-radius:8px;border:1px solid var(--border-color);" poster="${e(ogImage)}"></video></div>`;
            if (m.type === "pdf")   return `<div class="media-item"><a href="${e(m.url)}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:8px;padding:12px 16px;background:#f0f7ff;border:1px solid #d0e1fd;border-radius:8px;text-decoration:none;color:#1967d2;font-size:14px;font-weight:600;"><svg width="16" height="16" viewBox="0 0 24 24" fill="#1967d2"><path d="M20 2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg> 📄 ${e(m.name || "View Document")}</a></div>`;
            return "";
        }).join("") + '</div>';
    }

const extLinkHtml = extLink.trim()
? `<div onclick="requireAuth(async function(){ await trackClick('${e(postDocId)}','linkClicks'); window.open('${e(extLink)}','_blank'); })"   style="display:inline-flex;align-items:center;gap:8px;margin-top:10px;margin-bottom:5px;padding:10px 16px;background:#f0f7ff;border:1px solid #d0e1fd;border-radius:8px;color:#1967d2;font-size:14px;font-weight:600;cursor:pointer;"><svg width="16" height="16" viewBox="0 0 24 24" fill="#1967d2"><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/></svg>Visit link</div>`
    : "";
    const chatBtn = "";
    const waNum = (post.whatsapp || "").replace(/[^0-9]/g, "");
    const waFinal = waNum.startsWith("0") ? "92" + waNum.substring(1) : waNum;
    const waMsg2 = encodeURIComponent(`Hi, I saw your post "${title}" on Health Jobs Portal.`);

const whatsappBtn = waFinal
    ? `<div class="circle-btn-wrapper" style="cursor:pointer;" onclick="requireAuth(async function(){ await trackClick('${e(postDocId)}','whatsappClicks'); window.open('https://wa.me/${waFinal}?text=${waMsg2}','_blank'); })"><div class="circle-btn btn-wa"><svg viewBox="0 0 24 24"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51a12.8 12.8 0 0 0-.57-.01c-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z"/></svg></div><span class="btn-label">WhatsApp</span></div>`
    : "";

const callBtn = (post.localNum || "").trim()
    ? `<div class="circle-btn-wrapper" style="cursor:pointer;" onclick="requireAuth(async function(){ await trackClick('${e(postDocId)}','callClicks'); window.location.href='tel:${e((post.localNum||"").trim())}'; })"><div class="circle-btn btn-call"><svg viewBox="0 0 24 24"><path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/></svg></div><span class="btn-label">Call</span></div>`
    : "";

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0,user-scalable=no">
<title>${e(pageTitle)}</title>
<meta name="description" content="${e(metaDesc)}">
<meta name="keywords" content="medical news Pakistan, healthcare update ${e(city)}, clinical update, medical news today, ${e(posterName)}, health news Pakistan">
<meta name="news_keywords" content="medical news, healthcare, clinical update, Pakistan health">
<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large">
<link rel="canonical" href="${e(canonicalUrl)}">
<meta property="og:type" content="article">
<meta property="og:url" content="${e(canonicalUrl)}">
<meta property="og:title" content="${e(pageTitle)}">
<meta property="og:description" content="${e(metaDesc)}">
<meta property="og:image" content="${e(ogImage)}">
<meta property="og:site_name" content="${e(SITE_NAME)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${e(pageTitle)}">
<meta name="twitter:description" content="${e(metaDesc)}">
<meta name="twitter:image" content="${e(ogImage)}">
<script type="application/ld+json">${jsonLd}<\/script>
<script>
setTimeout(function(){
let s1=document.createElement('script');s1.src="https://www.googletagmanager.com/gtag/js?id=G-NC0B547PYR";s1.async=true;document.head.appendChild(s1);
let s2=document.createElement('script');s2.innerHTML="window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-NC0B547PYR');";document.head.appendChild(s2);
let s3=document.createElement('script');s3.src="https://analytics.ahrefs.com/analytics.js";s3.setAttribute("data-key","lZziwIFYdWn//NVwsT+mUg");s3.async=true;document.head.appendChild(s3);
},3500);
<\/script>
<style>
:root{--primary-blue:#0a66c2;--hover-blue:#004182;--bg-white:#ffffff;--bg-body:#f3f2ef;--text-main:#000000e6;--text-secondary:#00000099;--border-color:#e0dfdc;--wa-green:#25D366;}
*{margin:0;padding:0;box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;}
body{background:var(--bg-body);color:var(--text-main);padding-top:70px;padding-bottom:30px;}
header{background:var(--bg-white);padding:0 15px;display:flex;align-items:center;gap:15px;position:fixed;top:0;left:0;width:100%;height:65px;z-index:1000;border-bottom:1px solid var(--border-color);box-shadow:0 1px 3px rgba(0,0,0,0.05);}
.back-btn{background:none;border:none;cursor:pointer;color:var(--text-secondary);display:flex;align-items:center;padding:5px;}
.back-btn:hover{color:var(--primary-blue);}
.back-btn svg{width:26px;height:26px;fill:currentColor;}
.logo-text{font-size:18px;font-weight:700;color:var(--text-main);}
main{width:100%;padding:0 10px;}
.details-card{background:var(--bg-white);border-radius:12px;border:1px solid var(--border-color);box-shadow:0 2px 4px rgba(0,0,0,0.02);padding:25px;margin-top:10px;}
.user-section{display:flex;align-items:center;gap:15px;margin-bottom:20px;padding-bottom:18px;border-bottom:1px solid #f1f1f1;}
.user-avatar{width:56px;height:56px;border-radius:50%;object-fit:cover;border:2px solid var(--border-color);}
.user-details{flex:1;}
.user-name{font-size:17px;font-weight:700;color:var(--text-main);margin-bottom:3px;}
.post-badge{display:inline-block;font-size:10px;padding:3px 8px;border-radius:12px;background:#f0fdf4;color:#16a34a;border:1px solid #bbf7d0;font-weight:800;text-transform:uppercase;margin-bottom:4px;}
.post-time{font-size:12px;color:var(--text-secondary);font-weight:500;}
.update-title{font-size:22px;font-weight:800;color:var(--text-main);line-height:1.35;margin-bottom:18px;}
.update-desc{font-size:15px;line-height:1.75;color:#333;margin-bottom:24px;word-wrap:break-word;overflow-wrap:break-word;}
.update-desc h1{font-size:20px;font-weight:800;margin:10px 0 6px;}
.update-desc h2{font-size:17px;font-weight:700;margin:8px 0 4px;}
.update-desc p{margin:0 0 8px;}
.update-desc ul,.update-desc ol{margin:6px 0;padding-left:22px;}
.update-desc li{margin-bottom:3px;}
.update-desc strong{font-weight:700;}
.media-container{display:flex;flex-direction:column;gap:15px;margin-bottom:20px;}
.media-item img{width:100%;border-radius:0;border:none;object-fit:cover;max-height:500px;display:block;}
.media-item{border-radius:0;overflow:hidden;margin:0 -25px;}
.ext-link-btn{display:inline-flex;align-items:center;gap:8px;margin-top:8px;margin-bottom:8px;padding:10px 16px;background:#f0f7ff;border:1px solid #d0e1fd;border-radius:8px;text-decoration:none;color:#1967d2;font-size:14px;font-weight:600;}
.stats-bar{padding:10px 0;display:flex;justify-content:space-between;font-size:12px;font-weight:600;color:var(--text-secondary);border-top:1px solid #f1f1f1;border-bottom:1px solid #f1f1f1;margin-top:12px;}
.post-actions{display:flex;padding:4px 0;border-bottom:1px solid #f1f1f1;}
.action-btn{flex:1;background:none;border:none;padding:10px 0;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;color:var(--text-secondary);font-size:13px;font-weight:600;transition:0.2s;border-radius:8px;margin:0 2px;font-family:inherit;}
.action-btn:hover,.action-btn:active{background:#f1f5f9;}
.action-btn.liked{color:var(--primary-blue);}
.action-btn svg{width:18px;height:18px;fill:currentColor;}
.cmt-item{display:flex;gap:8px;margin-bottom:10px;position:relative;}
.cmt-avatar{width:30px;height:30px;min-width:30px;border-radius:50%;object-fit:cover;border:1px solid #e2e8f0;cursor:pointer;margin-top:2px;}
.cmt-bubble{flex:1;background:#fff;border:1px solid #e8edf2;border-radius:0 10px 10px 10px;padding:8px 10px;min-width:0;}
.cmt-user{font-weight:700;font-size:12px;color:#0f172a;display:block;margin-bottom:2px;}
.cmt-txt{font-size:13px;color:#334155;line-height:1.4;word-break:break-word;}
.cmt-footer{display:flex;align-items:center;gap:8px;margin-top:5px;}
.cmt-like-btn,.cmt-dislike-btn{display:flex;align-items:center;gap:3px;background:none;border:none;cursor:pointer;font-size:11px;font-weight:600;color:#94a3b8;padding:2px 5px;border-radius:6px;transition:0.15s;}
.cmt-like-btn:hover{background:#f1f5f9;color:#0a66c2;}
.cmt-dislike-btn:hover{background:#f1f5f9;color:#ef4444;}
.cmt-like-btn.active{color:#0a66c2;}
.cmt-dislike-btn.active{color:#ef4444;}
.cmt-like-btn svg,.cmt-dislike-btn svg{width:12px;height:12px;fill:currentColor;}
.cmt-reply-btn{background:none;border:none;cursor:pointer;font-size:11px;font-weight:600;color:#64748b;padding:2px 5px;border-radius:6px;transition:0.15s;}
.cmt-reply-btn:hover{background:#f1f5f9;color:#0a66c2;}
.cmt-3dot{background:none;border:none;cursor:pointer;color:#cbd5e1;padding:2px 4px;border-radius:6px;font-size:14px;line-height:1;margin-left:auto;transition:0.15s;}
.cmt-3dot:hover{background:#f1f5f9;color:#64748b;}
.replies-toggle-btn{display:flex;align-items:center;gap:4px;background:none;border:none;cursor:pointer;font-size:11px;font-weight:700;color:#0a66c2;padding:2px 0;margin-left:38px;margin-bottom:4px;}
.replies-toggle-btn svg{width:12px;height:12px;fill:currentColor;transition:transform 0.2s;}
.replies-toggle-btn.open svg{transform:rotate(180deg);}
.replies-list{margin-left:38px;margin-bottom:4px;}
.reply-item{display:flex;gap:7px;margin-bottom:7px;}
.reply-avatar{width:24px;height:24px;min-width:24px;border-radius:50%;object-fit:cover;border:1px solid #e2e8f0;cursor:pointer;margin-top:2px;}
.reply-bubble{flex:1;background:#f0f7ff;border:1px solid #dbeafe;border-radius:0 10px 10px 10px;padding:6px 9px;}
.reply-input-row{display:flex;gap:6px;margin-left:38px;margin-bottom:6px;align-items:center;overflow:hidden;}
.reply-input{flex:1;min-width:0;border:1px solid #e2e8f0;border-radius:16px;outline:none;font-size:12px;padding:6px 12px;background:#fff;color:#0f172a;}
.reply-input-row{display:flex;gap:6px;margin-left:38px;margin-bottom:6px;align-items:center;}
.reply-input{flex:1;border:1px solid #e2e8f0;border-radius:16px;outline:none;font-size:12px;padding:6px 12px;background:#fff;color:#0f172a;}
.reply-send-btn{background:#0a66c2;color:#fff;border:none;padding:6px 12px;border-radius:14px;font-weight:700;font-size:11px;cursor:pointer;}
.cmt-ctx-menu{position:fixed;background:#fff;border:1px solid #e2e8f0;border-radius:10px;box-shadow:0 6px 20px rgba(0,0,0,0.10);z-index:99999;min-width:140px;overflow:hidden;}
.cmt-ctx-item{display:flex;align-items:center;padding:11px 16px;font-size:13px;font-weight:600;color:#0f172a;cursor:pointer;border-bottom:1px solid #f1f5f9;transition:background 0.12s;}
.cmt-ctx-item:last-child{border-bottom:none;}
.cmt-ctx-item:hover{background:#f8fafc;}
.cmt-ctx-item.danger{color:#ef4444;}
.action-bar{position:fixed;bottom:0;left:0;width:100%;background:var(--bg-white);padding:15px 20px;border-top:1px solid var(--border-color);box-shadow:0 -4px 15px rgba(0,0,0,0.08);display:flex;justify-content:center;z-index:1000;}
.action-bar-inner{max-width:450px;width:100%;display:flex;justify-content:space-around;align-items:center;}
.circle-btn-wrapper{display:flex;flex-direction:column;align-items:center;gap:6px;text-decoration:none;cursor:pointer;}
.circle-btn{width:50px;height:50px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:white;box-shadow:0 4px 10px rgba(0,0,0,0.15);transition:0.3s;border:none;cursor:pointer;}
.circle-btn svg{width:24px;height:24px;fill:currentColor;}
.btn-label{font-size:12px;font-weight:700;color:var(--text-main);}
.btn-chat{background:var(--primary-blue);}.btn-chat:hover{background:var(--hover-blue);transform:translateY(-3px);}
.btn-wa{background:#25D366;}.btn-wa:hover{background:#1DA851;transform:translateY(-3px);}
.btn-call{background:#0078FF;}.btn-call:hover{background:#005bb5;transform:translateY(-3px);}
.report-popup{position:fixed;bottom:80px;left:50%;transform:translateX(-50%);width:calc(100% - 30px);max-width:480px;background:white;border-radius:14px;border:1px solid #e2e8f0;box-shadow:0 8px 30px rgba(0,0,0,0.15);z-index:9999;padding:18px;display:none;animation:slideUp 0.3s ease;}
.report-popup.show{display:block;}
@keyframes slideUp{from{opacity:0;transform:translateX(-50%) translateY(20px);}to{opacity:1;transform:translateX(-50%) translateY(0);}}
.report-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;}
.report-top h3{font-size:15px;font-weight:700;color:#0f172a;}
.report-close{background:#f1f5f9;border:none;border-radius:50%;width:28px;height:28px;font-size:16px;cursor:pointer;color:#64748b;display:flex;align-items:center;justify-content:center;}
.report-owner-box{display:flex;align-items:center;gap:10px;background:#f8fafc;padding:10px 12px;border-radius:10px;border:1px solid #e2e8f0;margin-bottom:14px;}
.report-owner-box img{width:38px;height:38px;border-radius:50%;object-fit:cover;border:1px solid #e2e8f0;}
.report-reasons{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px;}
.reason-chip{padding:7px 13px;border-radius:20px;border:1px solid #e2e8f0;font-size:12px;font-weight:600;cursor:pointer;background:#f8fafc;color:#334155;transition:0.2s;}
.reason-chip.selected{background:#0a66c2;color:white;border-color:#0a66c2;}
.report-input{width:100%;padding:10px 12px;border:1px solid #e2e8f0;border-radius:8px;font-size:13px;margin-bottom:10px;outline:none;font-family:inherit;}
.report-input:focus{border-color:#0a66c2;}
.report-submit{width:100%;padding:11px;background:#ef4444;color:white;border:none;border-radius:20px;font-size:14px;font-weight:700;cursor:pointer;transition:0.2s;}
.report-submit:hover{background:#dc2626;}
.report-success{text-align:center;padding:10px 0;font-size:14px;color:#16a34a;font-weight:600;display:none;}

/* ── Related Updates Section ── */
.related-section{margin-top:14px;margin-bottom:6px;background:var(--bg-white);border-radius:12px;border:1px solid var(--border-color);padding:20px;box-shadow:0 2px 4px rgba(0,0,0,0.02);}
.related-heading{font-size:15px;font-weight:800;color:var(--text-main);margin-bottom:12px;display:flex;align-items:center;gap:7px;}
.related-heading svg{width:18px;height:18px;fill:#16a34a;}
.rel-card{display:flex;align-items:center;gap:12px;background:var(--bg-white);border:1px solid var(--border-color);border-radius:12px;padding:14px;cursor:pointer;text-decoration:none;transition:box-shadow 0.2s,border-color 0.2s;margin-bottom:10px;}
.rel-card:last-child{margin-bottom:0;}
.rel-card:hover{box-shadow:0 4px 14px rgba(22,163,74,0.12);border-color:#86efac;}
.rel-thumb{width:64px;height:64px;border-radius:10px;object-fit:cover;border:1.5px solid var(--border-color);flex-shrink:0;background:#f0fdf4;}
.rel-info{flex:1;min-width:0;}
.rel-title{font-size:14px;font-weight:700;color:var(--text-main);margin-bottom:5px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.4;}
.rel-meta{font-size:11px;color:var(--text-secondary);display:flex;align-items:center;gap:5px;flex-wrap:wrap;}
.rel-badge{display:inline-block;font-size:9px;padding:2px 7px;border-radius:10px;background:#f0fdf4;color:#16a34a;border:1px solid #bbf7d0;font-weight:800;text-transform:uppercase;margin-bottom:4px;}
.rel-arrow{color:#b0b8c9;flex-shrink:0;}
.related-skeleton{background:linear-gradient(90deg,#f1f5f9 25%,#e8edf4 50%,#f1f5f9 75%);background-size:200% 100%;border-radius:12px;height:92px;margin-bottom:10px;animation:shimmer 1.2s infinite linear;}
@keyframes shimmer{0%{background-position:200% 0;}100%{background-position:-200% 0;}}

@media(max-width:480px){.update-title{font-size:19px;}.details-card{padding:18px;}}
.content-col{width:100%;min-width:0;}
.sidebar-col{width:100%;margin-top:0;}
.page-layout{display:block;width:100%;}
.site-footer{background:#fff;padding:24px 16px 40px;border-top:1px solid #cbd5e1;text-align:center;width:100%;}
.pc-banner{display:none;}
@media(min-width:701px){
  main{display:block;margin:0 auto;max-width:700px;padding:0;}
}
@media(min-width:1024px){
  .page-layout{display:block;width:100%;position:relative;}
  .pc-banner{display:flex;align-items:flex-start;justify-content:center;width:160px;position:fixed;top:75px;z-index:50;}
  .pc-banner-left{left:max(10px, calc(50% - 350px - 160px - 16px));}
  .pc-banner-right{left:min(calc(100% - 170px), calc(50% + 350px + 16px));}
  .pc-banner.pc-banner-stop{position:absolute;top:var(--pc-stop-top);}
  .pc-banner-inner{width:160px;min-height:600px;overflow:hidden;border-radius:10px;background:#f1f5f9;}
}
</style>
</head>
<body>

<header>
<button class="back-btn" onclick="window.location.href='https://healthjobportal.com/'">
        <svg viewBox="0 0 24 24"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
    </button>
    <div class="logo-text">Medical Update</div>
</header>

<div class="page-layout">
<div class="pc-banner pc-banner-left"><div class="pc-banner-inner"><script>atOptions={'key':'12e567a592eb923f9cea953d8fda0594','format':'iframe','height':600,'width':160,'params':{}};</script><script src="https://www.highperformanceformat.com/12e567a592eb923f9cea953d8fda0594/invoke.js"></script></div></div>
<div class="pc-banner pc-banner-right"><div class="pc-banner-inner"><script>atOptions={'key':'12e567a592eb923f9cea953d8fda0594','format':'iframe','height':600,'width':160,'params':{}};</script><script src="https://www.highperformanceformat.com/12e567a592eb923f9cea953d8fda0594/invoke.js"></script></div></div>
<main>
<div class="details-card">

    <div class="user-section">
<a href="${SITE_URL}/wid.html?uid=${e(post.posterId || '')}" style="flex-shrink:0;">
<img src="${e(posterPic)}" class="user-avatar" alt="${e(posterName)}"
             onerror="this.src='https://ui-avatars.com/api/?name=${encodeURIComponent(posterName)}&background=0a66c2&color=fff'">
</a>
        <div class="user-details">
            <div class="user-name">${e(posterName)}${verified ? '<span style="display:inline-flex;align-items:center;justify-content:center;background:#0a66c2;border-radius:50%;width:18px;height:18px;margin-left:4px;border:2px solid #fff;flex-shrink:0;"><svg viewBox=\"0 0 24 24\" width=\"10\" fill=\"white\"><path d=\"M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z\"/></svg></span>' : ''}</div>
            <div class="post-badge">🩺 Medical Update</div>
            <div class="post-time">${e(city)} &bull; ${formattedDate}</div>
        </div>
    </div>

${title ? `<div class="update-title">${e(title)}</div>` : ""}
<!-- TrustBox widget - Review Collector -->
<div class="trustpilot-widget" data-locale="en-US" data-template-id="56278e9abfbbba0bdcd568bc" data-businessunit-id="6a32028be10624a15deb07d6" data-style-height="52px" data-style-width="100%" data-token="4d97b915-5abc-4d24-9888-b4072d453a26">
  <a href="https://www.trustpilot.com/review/healthjobportal.com" target="_blank" rel="noopener">Trustpilot</a>
</div>
<!-- End TrustBox widget --> 

<div style="width:100%;text-align:center;overflow:hidden;margin:10px 0;">
<script>atOptions={'key':'333dc5bfbee4b34aa13ee95636901b9c','format':'iframe','height':60,'width':468,'params':{}};
<\/script><script src="https://www.highperformanceformat.com/333dc5bfbee4b34aa13ee95636901b9c/invoke.js"><\/script></div>

${desc ? `<div class="update-desc">${desc}</div>` : ""}

    ${extLinkHtml}
    <!-- Medical ID Card Promo -->
<div style="background:linear-gradient(135deg,#eff6ff 0%,#f0fdf4 100%);border:1px solid #bfdbfe;border-radius:14px;padding:16px 18px;margin:16px 0;">
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
    <span style="font-size:26px;">🪪</span>
<div style="font-size:14px;font-weight:800;color:#1e40af;">Generate Your Medical ID Card - Completely Free!</div>
  </div>
  <div style="font-size:13px;color:#334155;line-height:1.6;margin-bottom:12px;">
    A professional Digital Medical ID is your identity. Share it with hospitals, clinics and colleagues - ready in just a few seconds.
  </div>
  <a href="https://healthjobportal.com/id" style="display:inline-flex;align-items:center;gap:8px;background:#2563eb;color:white;padding:10px 20px;border-radius:20px;font-size:13px;font-weight:700;text-decoration:none;">
    <svg width="15" height="15" viewBox="0 0 24 24" fill="white"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V6h16v12zM6 10h2v2H6zm0 4h8v2H6zm10 0h2v2h-2zm-6-4h8v2h-8z"/></svg>
    Generate Medical ID Card
  </a>
</div>

<div style="display:flex;flex-wrap:wrap;gap:8px;margin:12px 0;align-items:center;">
${whatsappBtn}
${callBtn}
${chatBtn}
<div onclick="openReportPopup()" style="display:inline-flex;align-items:center;gap:4px;padding:5px 10px;background:#fff0f0;color:#ef4444;border:1px solid #fecaca;border-radius:20px;font-size:11px;font-weight:600;cursor:pointer;"><svg width="11" height="11" viewBox="0 0 24 24" fill="#ef4444"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>Report</div>
</div>
    ${mediaHtml}

    <!-- Stats Bar -->
    <div class="stats-bar">
        <span id="like-count-display">Loading...</span>
        <span id="cmt-count-display">0 Comments</span>
    </div>

    <!-- Action Buttons -->
    <div class="post-actions">
        <button class="action-btn" id="like-btn" onclick="doLike()">
            <svg viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
            Like
        </button>
        <button class="action-btn" onclick="toggleComments()">
            <svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
            Comment
        </button>
        <button class="action-btn" onclick="sharePost()">
            <svg viewBox="0 0 24 24"><path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z"/></svg>
            Share
        </button>
    </div>

<!-- Comments Section -->
    <div id="cmt-section" style="display:none;padding:16px;background:#f8fafc;border-top:1px solid #f1f1f1;">
        <div id="cmt-list" style="max-height:400px;overflow-y:auto;margin-bottom:12px;"></div>
        <div style="display:flex;gap:8px;">
            <input type="text" id="cmt-input" placeholder="Add a comment..." style="flex:1;padding:10px 16px;border:1px solid var(--border-color);border-radius:20px;outline:none;font-size:14px;background:#fff;font-family:inherit;">
            <button onclick="sendComment()" style="background:var(--primary-blue);color:#fff;border:none;padding:0 16px;border-radius:20px;font-weight:600;cursor:pointer;font-size:13px;">Post</button>
        </div>
    </div>

</div>

<div style="width:100%;text-align:center;overflow:hidden;margin:12px 0;">
<script>atOptions={'key':'333dc5bfbee4b34aa13ee95636901b9c','format':'iframe','height':60,'width':468,'params':{}};
<\/script><script src="https://www.highperformanceformat.com/333dc5bfbee4b34aa13ee95636901b9c/invoke.js"><\/script></div>

<div class="sidebar-col">
<!-- ── Related Updates Section ───────────────────────────────────────── -->
<div class="related-section">
    <div class="related-heading">
        <svg viewBox="0 0 24 24"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/></svg>
        More Updates
    </div>
    <div id="related-updates-list">
        <div class="related-skeleton"></div>
        <div class="related-skeleton"></div>
        <div class="related-skeleton"></div>
    </div>
</div>
</div>
</main>
</div>
<footer class="site-footer">
    <img src="https://healthjobportal.com/images/logo.png" alt="Health Jobs Portal"
         style="height:28px;object-fit:contain;margin-bottom:6px;opacity:0.8;"
         onerror="this.style.display='none'">
    <p style="font-size:11px;color:#64748b;font-weight:500;margin-bottom:14px;">Pakistan's #1 Digital Healthcare Network</p>
    <div style="display:flex;justify-content:center;flex-wrap:wrap;gap:12px;margin-bottom:12px;">
        <a href="https://healthjobportal.com/index.html" style="color:#64748b;text-decoration:none;font-size:12px;font-weight:600;">Home</a>
        <a href="https://healthjobportal.com/cv-maker.html" style="color:#64748b;text-decoration:none;font-size:12px;font-weight:600;">Cv maker</a>
        <a href="https://healthjobportal.com/about.html" style="color:#64748b;text-decoration:none;font-size:12px;font-weight:600;">About Us</a>
        <a href="https://healthjobportal.com/terms.html" style="color:#64748b;text-decoration:none;font-size:12px;font-weight:600;">Terms</a>
        <a href="https://healthjobportal.com/privcy.html" style="color:#64748b;text-decoration:none;font-size:12px;font-weight:600;">Privacy Policy</a>
    </div>
    <p style="font-size:11px;color:#94a3b8;font-weight:500;">&copy; 2026 Powered by SufianX</p>
</footer>
<div class="report-popup" id="report-popup">
    <div class="report-top">
        <h3>&#9872; Report this Post</h3>
        <button class="report-close" onclick="closeReport()">&#x2715;</button>
    </div>
    <div class="report-owner-box">
        <img src="${e(posterPic)}"
             onerror="this.src='https://ui-avatars.com/api/?name=${encodeURIComponent(posterName)}&background=0a66c2&color=fff'">
        <div>
            <div style="font-size:13px;font-weight:700;color:#0f172a;">${e(posterName)}</div>
            <div style="font-size:11px;color:#64748b;">Post Owner</div>
        </div>
    </div>
    <div class="report-reasons">
        <div class="reason-chip" onclick="selectReason(this)">Fake / Misleading</div>
        <div class="reason-chip" onclick="selectReason(this)">Wrong Info</div>
        <div class="reason-chip" onclick="selectReason(this)">Spam</div>
        <div class="reason-chip" onclick="selectReason(this)">Abusive Content</div>
        <div class="reason-chip" onclick="selectReason(this)">Duplicate Post</div>
        <div class="reason-chip" onclick="selectReason(this)">Other</div>
    </div>
    <input class="report-input" id="report-name" placeholder="Your Name *" maxlength="50">
    <textarea class="report-input" id="report-msg" placeholder="Describe the issue... *" rows="3" style="resize:none;"></textarea>
    <button class="report-submit" onclick="submitReport()">Send Report</button>
    <div class="report-success" id="report-success">&#x2705; Report submitted! We'll review it shortly.</div>
</div>

<script type="module">
import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getFirestore, doc, getDoc, updateDoc, arrayUnion, arrayRemove, collection, query, where, orderBy, onSnapshot, addDoc, deleteDoc, getDocs, serverTimestamp, increment } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const firebaseConfig = {
    apiKey: "AIzaSyD4Cfni7D2Kk_t6qeZ4jcWesIabnSM15mk",
    authDomain: "jobs-45cc9.firebaseapp.com",
    projectId: "jobs-45cc9",
    storageBucket: "jobs-45cc9.firebasestorage.app",
    messagingSenderId: "21065686301",
    appId: "1:21065686301:web:f461ea1b8aabe2fa5895f4"
};
const fireApp = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();
const auth = getAuth(fireApp);
const db = getFirestore(fireApp);
const POST_ID = ${JSON.stringify(slug)};
let currentUser = undefined;
let currentUserProfile = null;
let likesArr = [];

window.__authUser = undefined;
onAuthStateChanged(auth, async (user) => {
    currentUser = user;
    window.__authUser = user;
    if (user) {
        try {
            const snap = await getDoc(doc(db, "users", user.uid));
            if (snap.exists()) {
                const d = snap.data();
                const name = d.fullName || d.facilityName || "User";
                currentUserProfile = { name, pic: d.profilePicUrl || "https://ui-avatars.com/api/?name=" + encodeURIComponent(name) };
            }
        } catch(e) {}
    }
    loadLikes();
    loadComments();
});

async function loadLikes() {
    try {
        const snap = await getDoc(doc(db, "posts", POST_ID));
        if (snap.exists()) {
            likesArr = snap.data().likes || [];
            updateLikeUI();
        }
    } catch(e) {}
}

function updateLikeUI() {
    const btn = document.getElementById('like-btn');
    const countEl = document.getElementById('like-count-display');
    const isLiked = !!(currentUser && likesArr.includes(currentUser.uid));
    if (btn) btn.classList.toggle('liked', isLiked);
    if (countEl) countEl.innerText = likesArr.length + " Likes";
}

window.doLike = async function() {
    if (currentUser === undefined) { setTimeout(() => window.doLike(), 200); return; }
    if (!currentUser) { sessionStorage.setItem('redirectAfterLogin', window.location.href); window.location.replace("https://healthjobportal.com/login.html"); return; }
    const isLiked = likesArr.includes(currentUser.uid);
    likesArr = isLiked ? likesArr.filter(id => id !== currentUser.uid) : [...likesArr, currentUser.uid];
    updateLikeUI();
    try {
        const postRef = doc(db, "posts", POST_ID);
        await updateDoc(postRef, { likes: isLiked ? arrayRemove(currentUser.uid) : arrayUnion(currentUser.uid) });
        if (!isLiked) {
            try {
                const postSnap = await getDoc(postRef);
                const ownerId = postSnap.data()?.posterId;
                if (ownerId && ownerId !== currentUser.uid) {
                    await addDoc(collection(db, "notifications"), {
                        toUid: ownerId, fromUid: currentUser.uid,
                        fromName: currentUserProfile?.name || "Someone",
                        fromPic: currentUserProfile?.pic || "",
                        type: "like", postId: POST_ID,
                        postSlug: ${JSON.stringify(slug)},
                         postType: "general_post",
                        message: "liked your post", createdAt: Date.now(), read: false
                    });
                    fetch("${NOTIFY_API_URL}/api/server", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            toUid: ownerId, fromUid: currentUser.uid,
                            fromName: currentUserProfile?.name || "Someone",
                            type: "like", postId: POST_ID,
                            postSlug: ${JSON.stringify(slug)},
                            message: "liked your post"
                        })
                    }).catch(e => console.error("Notify API error:", e));
                }
            } catch(e) {}
        }
    } catch(e) {}
};

// ── Context Menu ──────────────────────────────────────────────────
window.closeCmtCtxMenu = function() {
    const m = document.getElementById('cmt-ctx-global');
    if (m) m.remove();
};
document.addEventListener('click', window.closeCmtCtxMenu);

function showCmtCtxMenu(e, cid, isMe) {
    window.closeCmtCtxMenu();
    if (!isMe) return;
    e.preventDefault(); e.stopPropagation();
    const menu = document.createElement('div');
    menu.className = 'cmt-ctx-menu';
    menu.id = 'cmt-ctx-global';
    menu.innerHTML = \`
        <div class="cmt-ctx-item" onclick="closeCmtCtxMenu();editCmt('\${cid}')">Edit</div>
        <div class="cmt-ctx-item danger" onclick="closeCmtCtxMenu();deleteCmt('\${cid}')">Delete</div>\`;
const btn = e.target.closest('button') || e.target;
const rect = btn.getBoundingClientRect();
const menuW = 150, menuH = 80;
let left = rect.left;
let top = rect.top - menuH - 8;
if (left + menuW > window.innerWidth) left = window.innerWidth - menuW - 8;
if (top < 8) top = rect.bottom + 8;
menu.style.left = left + 'px';
menu.style.top  = top + 'px';
    document.body.appendChild(menu);
    setTimeout(() => document.addEventListener('click', window.closeCmtCtxMenu, { once: true }), 50);
}

// ── Comment Reactions ─────────────────────────────────────────────
window.toggleCmtReaction = async function(cid, type) {
    if (!currentUser) { sessionStorage.setItem('redirectAfterLogin', window.location.href); window.location.replace("https://healthjobportal.com/login.html"); return; }
    const uid = currentUser.uid;
    const lBtn   = document.getElementById('lbtn-' + cid);
    const dBtn   = document.getElementById('dbtn-' + cid);
    const lCount = document.getElementById('lcount-' + cid);
    const dCount = document.getElementById('dcount-' + cid);
    const wasLiked    = lBtn?.classList.contains('active');
    const wasDisliked = dBtn?.classList.contains('active');
    if (type === 'like') {
        lBtn?.classList.toggle('active', !wasLiked);
        dBtn?.classList.remove('active');
        if (lCount) lCount.innerText = !wasLiked ? (parseInt(lCount.innerText||'0')+1)||1 : Math.max(0,parseInt(lCount.innerText||'1')-1)||'';
        if (wasDisliked && dCount) dCount.innerText = Math.max(0,parseInt(dCount.innerText||'1')-1)||'';
    } else {
        dBtn?.classList.toggle('active', !wasDisliked);
        lBtn?.classList.remove('active');
        if (dCount) dCount.innerText = !wasDisliked ? (parseInt(dCount.innerText||'0')+1)||1 : Math.max(0,parseInt(dCount.innerText||'1')-1)||'';
        if (wasLiked && lCount) lCount.innerText = Math.max(0,parseInt(lCount.innerText||'1')-1)||'';
    }
    try {
        const cmtRef = doc(db, "posts", POST_ID, "comments", cid);
        const snap = await getDoc(cmtRef);
        if (!snap.exists()) return;
        const data = snap.data();
        let likes    = data.likes    || [];
        let dislikes = data.dislikes || [];
        if (type === 'like') {
            likes    = likes.includes(uid) ? likes.filter(u => u !== uid) : [...likes, uid];
            dislikes = dislikes.filter(u => u !== uid);
        } else {
            dislikes = dislikes.includes(uid) ? dislikes.filter(u => u !== uid) : [...dislikes, uid];
            likes    = likes.filter(u => u !== uid);
        }
        await updateDoc(cmtRef, { likes, dislikes });
    } catch(e) {}
};

// ── Reply Box ─────────────────────────────────────────────────────
window.showReplyBox = function(parentCid, toName) {
    document.querySelectorAll('.reply-input-row').forEach(b => b.remove());
    const row = document.createElement('div');
    row.className = 'reply-input-row';
    row.id = 'reply-row-' + parentCid;
    row.innerHTML = \`
        <input class="reply-input" id="reply-in-\${parentCid}" placeholder="Reply to \${escHtml(toName)}..." maxlength="300">
<button class="reply-send-btn" onclick="sendReply('\${parentCid}')" style="white-space:nowrap;flex-shrink:0;padding:6px 10px;font-size:11px;">Send</button>\`;
    const cmtItem = document.getElementById('cmt-item-' + parentCid);
    if (cmtItem) cmtItem.after(row);
    document.getElementById('reply-in-' + parentCid)?.focus();
};

window.sendReply = async function(parentCid) {
    if (!currentUser) { sessionStorage.setItem('redirectAfterLogin', window.location.href); window.location.replace("https://healthjobportal.com/login.html"); return; }
    const inp = document.getElementById('reply-in-' + parentCid);
    if (!inp) return;
    const text = inp.value.trim();
    if (!text) return;
    inp.disabled = true;
    const name = currentUserProfile?.name || "User";
    const pic  = currentUserProfile?.pic  || "https://ui-avatars.com/api/?name=" + encodeURIComponent(name);
    try {
        await addDoc(collection(db, "posts", POST_ID, "comments"), {
            text, userId: currentUser.uid, userName: name, userPic: pic,
            parentId: parentCid, createdAt: serverTimestamp()
        });
        await updateDoc(doc(db, "posts", POST_ID), { commentsCount: increment(1) });
        document.getElementById('reply-row-' + parentCid)?.remove();
    } catch(e) { inp.disabled = false; }
};

// ── Toggle Replies ────────────────────────────────────────────────
window.toggleReplies = function(parentCid) {
    const list = document.getElementById('replies-list-' + parentCid);
    const btn  = document.getElementById('replies-toggle-' + parentCid);
    if (!list || !btn) return;
    const isOpen = list.style.display !== 'none';
    list.style.display = isOpen ? 'none' : 'block';
    btn.classList.toggle('open', !isOpen);
};

// ── Build Comment Element ─────────────────────────────────────────
function buildCmtEl(c, isReply) {
    const isMe   = !!(currentUser && c.userId === currentUser.uid);
    const myUid  = currentUser?.uid || '';
    const pic    = c.userPic || "https://ui-avatars.com/api/?name=" + encodeURIComponent(c.userName||'U');
    const likes    = Array.isArray(c.likes)    ? c.likes    : [];
    const dislikes = Array.isArray(c.dislikes) ? c.dislikes : [];
    const lCount = likes.length;
    const dCount = dislikes.length;
    const iL = likes.includes(myUid);
    const iD = dislikes.includes(myUid);

    const wrap = document.createElement('div');
    wrap.id = 'cmt-item-' + c.id;
    wrap.className = isReply ? 'reply-item' : 'cmt-item';

    const avatarClass  = isReply ? 'reply-avatar' : 'cmt-avatar';
    const bubbleClass  = isReply ? 'reply-bubble'  : 'cmt-bubble';

    wrap.innerHTML = \`
        <img src="\${pic}" class="\${avatarClass}"
            onclick="location.href='https://healthjobportal.com/wid.html?uid=\${c.userId}'"
            onerror="this.src='https://ui-avatars.com/api/?name=U'">
        <div class="\${bubbleClass}">
            <span class="cmt-user">\${escHtml(c.userName || 'User')}</span>
            <div class="cmt-txt" id="txt-\${c.id}">\${escHtml(c.text)}</div>
            <div class="cmt-footer">
                <button class="cmt-like-btn \${iL?'active':''}" id="lbtn-\${c.id}"
                    onclick="window.toggleCmtReaction('\${c.id}','like')">
                    <svg viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
                    <span id="lcount-\${c.id}">\${lCount > 0 ? lCount : ''}</span>
                </button>
                <button class="cmt-dislike-btn \${iD?'active':''}" id="dbtn-\${c.id}"
                    onclick="window.toggleCmtReaction('\${c.id}','dislike')">
                    <svg viewBox="0 0 24 24"><path d="M15 3H6c-.83 0-1.54.5-1.84 1.22l-3.02 7.05c-.09.23-.14.47-.14.73v2c0 1.1.9 2 2 2h6.31l-.95 4.57-.03.32c0 .41.17.79.44 1.06L9.83 23l6.59-6.59c.36-.36.58-.86.58-1.41V5c0-1.1-.9-2-2-2zm4 0v12h4V3h-4z"/></svg>
                    <span id="dcount-\${c.id}">\${dCount > 0 ? dCount : ''}</span>
                </button>
                \${!isReply ? \`<button class="cmt-reply-btn" onclick="window.showReplyBox('\${c.id}','\${escHtml(c.userName||'User')}')">Reply</button>\` : ''}
                \${isMe ? \`<button class="cmt-3dot" onclick="event.stopPropagation();showCmtCtxMenu(event,'\${c.id}',true)">···</button>\` : ''}
            </div>
        </div>\`;

    if (isMe) {
        let pressTimer;
        wrap.addEventListener('touchstart', (e) => { pressTimer = setTimeout(() => showCmtCtxMenu(e, c.id, true), 600); }, { passive: true });
        wrap.addEventListener('touchend',  () => clearTimeout(pressTimer));
        wrap.addEventListener('touchmove', () => clearTimeout(pressTimer));
    }
    return wrap;
}

// ── Load Comments ─────────────────────────────────────────────────
function loadComments() {
    const cmtList = document.getElementById('cmt-list');
    const countEl = document.getElementById('cmt-count-display');
    if (!cmtList) return;
    const q = query(collection(db, "posts", POST_ID, "comments"), orderBy("createdAt", "asc"));
    onSnapshot(q, (snap) => {
        if (countEl) countEl.innerText = snap.size + " Comments";
        const allCmts = [];
        snap.forEach(d => {
            const c = d.data();
            allCmts.push({ id: d.id, ...c });
        });
        const topLevel   = allCmts.filter(c => !c.parentId);
        const repliesMap = {};
        allCmts.filter(c => c.parentId).forEach(r => {
            if (!repliesMap[r.parentId]) repliesMap[r.parentId] = [];
            repliesMap[r.parentId].push(r);
        });
        cmtList.innerHTML = '';
        topLevel.forEach(c => {
            cmtList.appendChild(buildCmtEl(c, false));
            const myReplies = repliesMap[c.id] || [];
            if (myReplies.length > 0) {
                const togBtn = document.createElement('button');
                togBtn.className = 'replies-toggle-btn';
                togBtn.id = 'replies-toggle-' + c.id;
                togBtn.innerHTML = \`<svg viewBox="0 0 24 24"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg> \${myReplies.length} \${myReplies.length===1?'Reply':'Replies'}\`;
                togBtn.onclick = () => window.toggleReplies(c.id);
                cmtList.appendChild(togBtn);
                const replList = document.createElement('div');
                replList.className = 'replies-list';
                replList.id = 'replies-list-' + c.id;
                replList.style.display = 'none';
                myReplies.forEach(r => replList.appendChild(buildCmtEl(r, true)));
                cmtList.appendChild(replList);
            }
        });
        if (topLevel.length === 0) cmtList.innerHTML = '<div style="text-align:center;padding:16px;color:#94a3b8;font-size:12px;">No comments yet. Be first!</div>';
        cmtList.scrollTop = cmtList.scrollHeight;
    });
}

window.toggleComments = function() {
    if (currentUser === undefined) { let w=0; const iv=setInterval(()=>{ w+=100; if(currentUser!==undefined){ clearInterval(iv); if(currentUser) _openComments(); else { sessionStorage.setItem('redirectAfterLogin',window.location.href); window.location.replace("https://healthjobportal.com/login.html"); } } if(w>5000){ clearInterval(iv); window.location.replace("https://healthjobportal.com/login.html"); } },100); return; }
    if (!currentUser) { sessionStorage.setItem('redirectAfterLogin', window.location.href); window.location.replace("https://healthjobportal.com/login.html"); return; }
    _openComments();
};
function _openComments() {
    const section = document.getElementById('cmt-section');
    if (!section) return;
    const open = section.style.display === 'block';
    section.style.display = open ? 'none' : 'block';
    if (!open) { const inp = document.getElementById('cmt-input'); if (inp) inp.focus(); }
}

window.sendComment = async function() {
    if (currentUser === undefined) { setTimeout(() => window.sendComment(), 200); return; }
    if (!currentUser) { sessionStorage.setItem('redirectAfterLogin', window.location.href); window.location.replace("https://healthjobportal.com/login.html"); return; }
    const inp = document.getElementById('cmt-input');
    if (!inp || !inp.value.trim()) return;
    const text = inp.value.trim();
    inp.value = "";
    const name = currentUserProfile?.name || "User";
    const pic = currentUserProfile?.pic || "https://ui-avatars.com/api/?name=" + encodeURIComponent(name);
    try {
        await addDoc(collection(db, "posts", POST_ID, "comments"), { text, userId: currentUser.uid, userName: name, userPic: pic, createdAt: serverTimestamp() });
        await updateDoc(doc(db, "posts", POST_ID), { commentsCount: increment(1) });
        try {
            const postSnap = await getDoc(doc(db, "posts", POST_ID));
            const ownerId = postSnap.data()?.posterId;
            if (ownerId && ownerId !== currentUser.uid) {
                await addDoc(collection(db, "notifications"), {
                    toUid: ownerId, fromUid: currentUser.uid,
                    fromName: currentUserProfile?.name || "Someone",
                    fromPic: currentUserProfile?.pic || "",
                    type: "comment", postId: POST_ID,
                    postSlug: ${JSON.stringify(slug)},
                    postType: "employer_post",
                    message: "commented on your post", createdAt: Date.now(), read: false
                });
                fetch("${NOTIFY_API_URL}/api/server", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        toUid: ownerId, fromUid: currentUser.uid,
                        fromName: currentUserProfile?.name || "Someone",
                        type: "comment", postId: POST_ID,
                        postSlug: ${JSON.stringify(slug)},
                        message: "commented on your post"
                    })
                }).catch(e => console.error("Notify API error:", e));
            }
        } catch(e) {}
    } catch(e) { inp.value = text; }
};

window.deleteCmt = async function(cmtId) {
    if (!currentUser || !confirm("Delete this comment?")) return;
    try {
        // replies بھی delete کرو
        const repliesSnap = await getDocs(
            query(collection(db, "posts", POST_ID, "comments"),
            where("parentId", "==", cmtId))
        );
        const batch = [];
        repliesSnap.forEach(r => batch.push(deleteDoc(doc(db, "posts", POST_ID, "comments", r.id))));
        await Promise.all(batch);
        await deleteDoc(doc(db, "posts", POST_ID, "comments", cmtId));
        // count onSnapshot خود update کرے گا — manually نہ چھیڑو
    } catch(e) { console.error(e); }
};

window.editCmt = async function(cmtId) {
    const txtEl = document.getElementById('txt-' + cmtId);
    if (!txtEl) return;
    const old = txtEl.innerText;
    const nt = prompt("Edit comment:", old);
    if (nt && nt !== old) await updateDoc(doc(db, "posts", POST_ID, "comments", cmtId), { text: nt.trim() });
};

function escHtml(s) {
    return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

document.addEventListener('DOMContentLoaded', () => {
    const inp = document.getElementById('cmt-input');
    if (inp) inp.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); window.sendComment(); } });
});

window.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => trackView(${JSON.stringify(slug)}), 2000);
    loadRelatedUpdates();
});

async function loadRelatedUpdates() {
    const list = document.getElementById('related-updates-list');
    if (!list) return;
    const CURRENT_SLUG = ${JSON.stringify(slug)};
    const daySeed = Math.floor(Date.now() / 86400000);
    function seededShuffle(arr, seed) {
        const a = [...arr]; let s = seed;
        for (let i = a.length-1; i > 0; i--) {
            s = (s * 1664525 + 1013904223) & 0xffffffff;
            const j = Math.abs(s) % (i+1);
            [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
    }
    try {
        const res = await fetch('/api/related-updates-pool');
        const pool = await res.json();
        const filtered = seededShuffle(
            pool.filter(p => p.slug !== CURRENT_SLUG), daySeed
        ).slice(0, 5);
        if (!filtered.length) {
            list.innerHTML = '<p style="font-size:13px;color:#94a3b8;text-align:center;padding:14px 0;">No related updates found.</p>';
            return;
        }
        list.innerHTML = filtered.map(p => {
            const pPic = p.posterPic || \`https://ui-avatars.com/api/?name=\${encodeURIComponent('U')}&background=16a34a&color=fff\`;
            const thumb = p.thumb || pPic;
            return \`<a class="rel-card" href="/updates/\${p.slug}">
                <img class="rel-thumb" src="\${thumb}" onerror="this.src='\${pPic}'" alt="" loading="lazy">
                <div class="rel-info">
                    <div class="rel-title">\${(p.title||p.desc||'').replace(/</g,'&lt;')}</div>
                    <div class="rel-meta">
                        <span class="rel-badge">🩺 Update</span>
                        \${p.location ? '<span>📍 '+p.location+'</span>' : ''}
                    </div>
                </div>
                <svg class="rel-arrow" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z"/></svg>
            </a>\`;
        }).join('');
    } catch(err) {
        list.innerHTML = '';
    }
}
<\/script>
<script src="https://cdn.jsdelivr.net/npm/@emailjs/browser@4/dist/email.min.js"><\/script>
<script>
emailjs.init('Rr88IrZ8s69Qyj8DS');

function requireAuth(action) {
    if (window.__authUser === undefined) {
        let waited = 0;
        const interval = setInterval(() => {
            waited += 100;
            if (window.__authUser !== undefined) {
                clearInterval(interval);
                if (window.__authUser) { action(); }
                else { sessionStorage.setItem('redirectAfterLogin', window.location.href); window.location.replace("https://healthjobportal.com/login.html"); }
            }
            if (waited > 8000) {
                clearInterval(interval);
                sessionStorage.setItem('redirectAfterLogin', window.location.href);
                window.location.replace("https://healthjobportal.com/login.html");
            }
        }, 100);
    } else if (window.__authUser) {
        action();
    } else {
        sessionStorage.setItem('redirectAfterLogin', window.location.href);
        window.location.replace("https://healthjobportal.com/login.html");
    }
}

async function trackClick(postId, field) {
    try {
        await fetch('/api/track', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ postId, field, collection: 'posts' })
        });
    } catch(e) { console.log('Track error:', e); }
}

async function trackView(postId) {
    try {
        const uid = window.__authUser?.uid || ('guest_' + Math.random().toString(36).substr(2,9));
        const key = 'viewed_' + postId + '_' + uid;
        if (localStorage.getItem(key)) return;
        localStorage.setItem(key, '1');
        await fetch('/api/track', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ postId, field: 'views', collection: 'posts' })
        });
    } catch(e) { console.log('View track error:', e); }
}
function openReportPopup(){ document.getElementById('report-popup').classList.add('show'); }
function closeReport(){ document.getElementById('report-popup').classList.remove('show'); }
function selectReason(el){
    document.querySelectorAll('.reason-chip').forEach(c => c.classList.remove('selected'));
    el.classList.add('selected'); selectedReason = el.innerText;
}
let selectedReason = '';
async function submitReport(){
    const name = document.getElementById('report-name').value.trim();
    const msg  = document.getElementById('report-msg').value.trim();
    if(!selectedReason){ alert('Please select a reason.'); return; }
    if(!name){ alert('Please enter your name.'); return; }
    if(!msg){ alert('Please describe the issue.'); return; }
    const btn = document.querySelector('.report-submit');
    btn.innerText = 'Sending...'; btn.disabled = true;
    try {
        await emailjs.send('service_gnjsdvm', 'template_bus1179', {
            reporter_name: name, reason: selectedReason, message: msg,
            post_owner: '${e(posterName)}', post_title: '${e(title)}',
            post_id: '${e(slug)}', post_url: '${e(canonicalUrl)}'
        });
        btn.style.display = 'none';
        document.getElementById('report-success').style.display = 'block';
        setTimeout(() => closeReport(), 3000);
    } catch(err) {
        alert('Error sending report. Try again.');
        btn.innerText = 'Send Report'; btn.disabled = false;
    }
}
window.openLightbox = function(url){
    let lb = document.getElementById('lightbox');
    if (!lb) {
        lb = document.createElement('div');
        lb.id = 'lightbox';
        lb.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,0.95);z-index:99999;align-items:center;justify-content:center;flex-direction:column;';
        lb.onclick = function(){ lb.style.display='none'; document.body.style.overflow=''; };
        lb.innerHTML = '<button style="position:absolute;top:16px;right:16px;background:rgba(255,255,255,0.15);border:none;color:white;width:38px;height:38px;border-radius:50%;font-size:22px;cursor:pointer;">&#x2715;</button><img id="lightbox-img" src="" style="max-width:100vw;max-height:100vh;object-fit:contain;" onclick="event.stopPropagation()">';
        document.body.appendChild(lb);
    }
    document.getElementById('lightbox-img').src = url;
    lb.style.display = 'flex';
    document.body.style.overflow = 'hidden';
}
function sharePost(){
    if(navigator.share){ navigator.share({ title: '${e(title)}', url: '${e(canonicalUrl)}' }); }
    else { navigator.clipboard.writeText('${e(canonicalUrl)}'); alert('Link copied!'); }
}
<\/script>
<script>
(function(){
  function pcBannerStop(){
    var footer = document.querySelector('.site-footer');
    var layout = document.querySelector('.page-layout');
    var banners = document.querySelectorAll('.pc-banner');
    if (!footer || !layout || !banners.length) return;
    var layoutRect = layout.getBoundingClientRect();
    var footerRect = footer.getBoundingClientRect();
    var bannerH = 600;
    var topOffset = 75;
    var hitsFooter = footerRect.top <= topOffset + bannerH;
    banners.forEach(function(b){
      if (hitsFooter) {
        var stopTop = (footerRect.top - layoutRect.top) - bannerH - 10;
        b.style.setProperty('--pc-stop-top', stopTop + 'px');
        b.classList.add('pc-banner-stop');
      } else {
        b.classList.remove('pc-banner-stop');
      }
    });
  }
  window.addEventListener('scroll', pcBannerStop, { passive: true });
  window.addEventListener('resize', pcBannerStop);
  document.addEventListener('DOMContentLoaded', pcBannerStop);
  setTimeout(pcBannerStop, 300);
})();
<\/script>
<!-- WhatsApp Channel Float Button -->
<div id="wa-channel-btn" onclick="window.open('https://whatsapp.com/channel/0029VbCe3Mf2kNFroj9qx223','_blank')" style="position:fixed;bottom:90px;right:16px;z-index:9998;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:4px;animation:waBounce 2s ease-in-out infinite;">
  <div style="background:#25D366;width:54px;height:54px;border-radius:50%;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 14px rgba(37,211,102,0.5);">
    <svg width="28" height="28" viewBox="0 0 24 24" fill="white"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51a12.8 12.8 0 0 0-.57-.01c-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z"/></svg>
  </div>
  <div style="background:#25D366;color:white;font-size:9px;font-weight:800;padding:3px 8px;border-radius:10px;white-space:nowrap;box-shadow:0 2px 8px rgba(37,211,102,0.4);">Join our<br>WhatsApp Channel</div>
</div>
<style>
@keyframes waBounce {
  0%, 100% { transform: translateY(0px); }
  50% { transform: translateY(-8px); }
}
</style>
</body>
</html>`;
}
// ── Medical Note Page Builder ─────────────────────────────────────────────────
function buildNotePage(post, slug, verified = false) {
    const e  = s => String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
    const eJ = s => String(s ?? "").replace(/\\/g,"\\\\").replace(/"/g,'\\"').replace(/\n/g,"\\n");

    const title      = post.title      || "Medical Note";
    const desc       = post.desc       || "";
    const posterName = post.posterName || SITE_NAME;
    const posterPic  = post.posterPic  || `https://ui-avatars.com/api/?name=${encodeURIComponent(posterName)}&background=2563eb&color=fff`;
    const city       = post.location   || "Pakistan";
    const diplomas   = Array.isArray(post.diplomas) ? post.diplomas : [];
    const pdfUrl     = post.pdfUrl     || "";
    const pdfName    = post.pdfName    || "medical-note.pdf";
    const postedDate = post.createdAt  || "";
    const canonicalUrl = `${SITE_URL}/notes/${slug}`;

    const pageTitle = `${title} | Medical Notes | ${SITE_NAME}`;
    const metaDesc  = desc
        ? desc.replace(/\n/g," ").trim().substring(0,157) + (desc.length > 157 ? "..." : "")
        : `Medical note by ${posterName} - ${diplomas.join(", ")} | ${SITE_NAME}`;
    const ogImage = posterPic || FALLBACK_IMG;

    let formattedDate = "Recently";
    if (postedDate) {
        try {
            formattedDate = new Date(
                typeof postedDate === "string" ? postedDate : (postedDate._seconds ? postedDate._seconds * 1000 : postedDate)
            ).toLocaleDateString("en-US", { day:"numeric", month:"short", year:"numeric" });
        } catch(_) {}
    }

    const diplomaTagsHtml = diplomas.map(d =>
        `<span class="diploma-tag">${e(d)}</span>`
    ).join("");

const jsonLd = JSON.stringify({
    "@context": "https://schema.org/",
    "@graph": [
        {
            "@type": ["MedicalWebPage", "ScholarlyArticle"],
            "headline": title,
            "description": metaDesc,
            "datePublished": typeof postedDate === "string" ? postedDate : new Date().toISOString(),
            "dateModified": typeof postedDate === "string" ? postedDate : new Date().toISOString(),
            "author": {
                "@type": "Person",
                "name": posterName,
                "image": posterPic,
                "hasCredential": diplomas.map(d => ({
                    "@type": "EducationalOccupationalCredential",
                    "credentialCategory": d
                }))
            },
            "publisher": {
                "@type": "Organization",
                "name": SITE_NAME,
                "logo": {
                    "@type": "ImageObject",
                    "url": FALLBACK_IMG
                }
            },
            "image": ogImage,
            "url": canonicalUrl,
            "mainEntityOfPage": {
                "@type": "WebPage",
                "@id": canonicalUrl
            },
            "about": {
                "@type": "MedicalCondition",
                "name": title
            },
            "specialty": diplomas.length > 0 ? {
                "@type": "MedicalSpecialty",
                "name": diplomas[0]
            } : { "@type": "MedicalSpecialty", "name": "General Practice" },
            "medicalAudience": {
                "@type": "MedicalAudience",
                "audienceType": "Clinician"
            },
            "keywords": diplomas.join(", ") + ", medical notes Pakistan, clinical notes, " + posterName,
            "educationalLevel": "Professional",
            "learningResourceType": "Lecture Notes",
            "inLanguage": "en-PK",
            "isAccessibleForFree": true,
            "hasPart": pdfUrl ? [{
                "@type": "MediaObject",
                "contentUrl": canonicalUrl,
                "encodingFormat": "application/pdf",
                "name": pdfName
            }] : []
        }
    ]
});

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0,user-scalable=no">
<title>${e(pageTitle)}</title>
<meta name="description" content="${e(metaDesc)}">
<meta name="keywords" content="${e(diplomas.join(', '))}, medical notes Pakistan, clinical notes, study material, ${e(posterName)}, healthcare notes, medical education">
<meta property="og:type" content="article">
<meta name="article:section" content="Medical Notes">
<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large">
<link rel="canonical" href="${e(canonicalUrl)}">
<meta property="og:type" content="article">
<meta property="og:url" content="${e(canonicalUrl)}">
<meta property="og:title" content="${e(pageTitle)}">
<meta property="og:description" content="${e(metaDesc)}">
<meta property="og:image" content="${e(ogImage)}">
<meta property="og:site_name" content="${e(SITE_NAME)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${e(pageTitle)}">
<meta name="twitter:description" content="${e(metaDesc)}">
<meta name="twitter:image" content="${e(ogImage)}">
<script type="application/ld+json">${jsonLd}<\/script>
<script>
setTimeout(function(){
let s1=document.createElement('script');s1.src="https://www.googletagmanager.com/gtag/js?id=G-NC0B547PYR";s1.async=true;document.head.appendChild(s1);
let s2=document.createElement('script');s2.innerHTML="window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-NC0B547PYR');";document.head.appendChild(s2);
let s3=document.createElement('script');s3.src="https://analytics.ahrefs.com/analytics.js";s3.setAttribute("data-key","lZziwIFYdWn//NVwsT+mUg");s3.async=true;document.head.appendChild(s3);
},3500);
<\/script>
<style>
.map-section{margin:20px 0;}.map-heading{font-size:14px;font-weight:700;color:var(--text-main);margin-bottom:8px;display:flex;align-items:center;gap:6px;}
.map-wrapper{position:relative;border-radius:12px;overflow:hidden;border:1px solid var(--border-color);cursor:pointer;height:200px;}
.map-iframe{width:100%;height:100%;border:none;display:block;pointer-events:none;}
.map-overlay{position:absolute;inset:0;background:transparent;}
.map-click-hint{position:absolute;bottom:10px;right:10px;background:rgba(10,102,194,0.9);color:white;padding:7px 12px;border-radius:20px;font-size:12px;font-weight:700;display:flex;align-items:center;gap:5px;}
.map-address{font-size:12px;color:var(--text-secondary);margin-top:7px;font-weight:600;}
:root{--primary:#2563eb;--hover:#1e40af;--bg:#f1f5f9;--white:#ffffff;--text:#0f172a;--muted:#64748b;--border:#cbd5e1;}
*{margin:0;padding:0;box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;}
body{background:var(--bg);color:var(--text);padding-top:65px;padding-bottom:40px;}
header{background:var(--white);height:65px;display:flex;align-items:center;gap:14px;padding:0 16px;position:fixed;top:0;left:0;width:100%;z-index:1000;border-bottom:1px solid var(--border);box-shadow:0 1px 3px rgba(0,0,0,0.05);}
.back-btn{background:none;border:none;cursor:pointer;color:var(--muted);display:flex;align-items:center;padding:4px;}
.back-btn:hover{color:var(--primary);}
.back-btn svg{width:24px;height:24px;fill:currentColor;}
.header-title{font-size:17px;font-weight:700;color:var(--text);}
main{width:100%;padding:16px 12px;}
.card{background:var(--white);border-radius:14px;border:1px solid var(--border);box-shadow:0 2px 8px rgba(0,0,0,0.04);padding:22px;margin-bottom:16px;}
.author-row{display:flex;align-items:center;gap:12px;padding-bottom:16px;border-bottom:1px solid #f1f5f9;margin-bottom:18px;}
.author-avatar{width:50px;height:50px;border-radius:50%;object-fit:cover;border:2px solid var(--border);}
.author-name{font-size:16px;font-weight:700;color:var(--text);margin-bottom:3px;}
.author-meta{font-size:12px;color:var(--muted);font-weight:500;}
.note-badge{display:inline-block;background:#eff6ff;color:var(--primary);border:1px solid #bfdbfe;padding:3px 10px;border-radius:12px;font-size:10px;font-weight:800;text-transform:uppercase;margin-bottom:4px;}
.note-title{font-size:22px;font-weight:800;color:var(--text);line-height:1.35;margin-bottom:14px;}
.diplomas-row{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:18px;}
.diploma-tag{background:#fef3c7;color:#b45309;padding:5px 14px;border-radius:20px;font-size:11px;font-weight:800;text-transform:uppercase;}
.note-desc{font-size:15px;line-height:1.75;color:#334155;margin-bottom:20px;word-wrap:break-word;overflow-wrap:break-word;}
.pdf-top-bar{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;padding:0 2px;}
.pdf-page-info{font-size:13px;font-weight:700;color:var(--muted);}
.pdf-dl-btn{background:#2563eb;border:none;color:white;padding:9px 20px;border-radius:20px;cursor:pointer;font-size:13px;font-weight:700;display:flex;align-items:center;gap:6px;transition:0.2s;}
.pdf-dl-btn:hover{background:#1e40af;}
.pdf-dl-btn svg{width:14px;height:14px;fill:currentColor;}
.pdf-pages-wrap{display:flex;flex-direction:column;gap:16px;margin-bottom:16px;}
.pdf-page-canvas{width:100%;border-radius:6px;box-shadow:0 2px 12px rgba(0,0,0,0.1);display:block;background:#fff;}
.pdf-loading{color:#64748b;font-size:14px;text-align:center;padding:30px 0;font-weight:600;}
@media(max-width:480px){.note-title{font-size:19px;}.card{padding:16px;}}
.content-col{width:100%;min-width:0;}
.sidebar-col{width:100%;}
@media(min-width:701px){
  main{display:block;margin:0 auto;max-width:700px;padding:0 10px;}
}
.pc-banner{display:none;}
@media(min-width:1024px){
  .page-layout{position:relative;}
  .pc-banner{display:flex;align-items:flex-start;justify-content:center;width:160px;position:fixed;top:75px;z-index:50;}
  .pc-banner-left{left:max(10px, calc(50% - 350px - 160px - 16px));}
  .pc-banner-right{left:min(calc(100% - 170px), calc(50% + 350px + 16px));}
  .pc-banner.pc-banner-stop{position:absolute;top:var(--pc-stop-top);}
  .pc-banner-inner{width:160px;min-height:600px;overflow:hidden;border-radius:10px;background:#f1f5f9;}
}
</style>
</head>
<body>
<header>
<button class="back-btn" onclick="window.location.href='https://healthjobportal.com/'">
        <svg viewBox="0 0 24 24"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
    </button>
    <div class="header-title">Medical Note</div>
</header>

<div class="page-layout">
<div class="pc-banner pc-banner-left"><div class="pc-banner-inner"><script>atOptions={'key':'12e567a592eb923f9cea953d8fda0594','format':'iframe','height':600,'width':160,'params':{}};</script><script src="https://www.highperformanceformat.com/12e567a592eb923f9cea953d8fda0594/invoke.js"></script></div></div>
<div class="pc-banner pc-banner-right"><div class="pc-banner-inner"><script>atOptions={'key':'12e567a592eb923f9cea953d8fda0594','format':'iframe','height':600,'width':160,'params':{}};</script><script src="https://www.highperformanceformat.com/12e567a592eb923f9cea953d8fda0594/invoke.js"></script></div></div>
<main>
<div class="card">
    <div class="author-row">
        <img class="author-avatar" src="${e(posterPic)}" alt="${e(posterName)}"
             onerror="this.src='https://ui-avatars.com/api/?name=${encodeURIComponent(posterName)}&background=2563eb&color=fff'">
        <div>
<div class="author-name">${e(posterName)}${verified ? '<span style="display:inline-flex;align-items:center;justify-content:center;background:#2563eb;border-radius:50%;width:18px;height:18px;margin-left:4px;border:2px solid #fff;flex-shrink:0;"><svg viewBox=\"0 0 24 24\" width=\"10\" fill=\"white\"><path d=\"M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z\"/></svg></span>' : ''}</div>
            <div class="note-badge">📋 Medical Note</div>
            <div class="author-meta">${e(city)} &bull; ${formattedDate}</div>
        </div>
    </div>

    ${title ? `<div class="note-title">${e(title)}</div>` : ""}

<div style="width:100%;text-align:center;overflow:hidden;margin:10px 0;">
<script>atOptions={'key':'333dc5bfbee4b34aa13ee95636901b9c','format':'iframe','height':60,'width':468,'params':{}};
<\/script><script src="https://www.highperformanceformat.com/333dc5bfbee4b34aa13ee95636901b9c/invoke.js"><\/script></div>

    ${diplomas.length > 0 ? `<div class="diplomas-row">${diplomaTagsHtml}</div>` : ""}
    <!-- Trustpilot Widget -->
<div class="trustpilot-widget" 
  data-locale="en-US" 
  data-template-id="56278e9abfbbba0bdcd568bc" 
  data-businessunit-id="6a32028be10624a15deb07d6" 
  data-style-height="52px" 
  data-style-width="100%" 
  data-token="4d97b915-5abc-4d24-9888-b4072d453a26">
  <a href="https://www.trustpilot.com/review/healthjobportal.com" target="_blank" rel="noopener">Trustpilot</a>
</div>
<script type="text/javascript" src="//widget.trustpilot.com/bootstrap/v5/tp.widget.bootstrap.min.js" async><\/script>
    ${desc ? `<div class="note-desc">${e(desc)}</div>` : ""}

<div style="width:100%;text-align:center;overflow:hidden;margin:10px 0;">
<script>atOptions={'key':'333dc5bfbee4b34aa13ee95636901b9c','format':'iframe','height':60,'width':468,'params':{}};
<\/script><script src="https://www.highperformanceformat.com/333dc5bfbee4b34aa13ee95636901b9c/invoke.js"><\/script></div>

${pdfUrl ? '<div class="pdf-top-bar"><span class="pdf-page-info" id="pdf-page-info">Loading...</span><button class="pdf-dl-btn" onclick="pdfDownload()"><svg viewBox=\"0 0 24 24\"><path d=\"M19 9h-4V3H9v6H5l7 7 7-7zm-8 2V5h2v6h1.17L12 13.17 9.83 11H11zm-6 7h14v2H5v-2z\"/></svg>Download PDF</button></div><div class="pdf-loading" id="pdf-loading">📄 Loading PDF...</div><div class="pdf-pages-wrap" id="pdf-canvas-wrap"></div>' : '<div style=\"text-align:center;padding:20px;color:var(--muted);font-size:14px;\">PDF not available</div>'}
</div>
</main>
</div>
<script>
const PDF_URL = "${e(pdfUrl)}";
const PDF_NAME = "${e(pdfName)}";
let pdfDoc = null, currentPage = 1, totalPages = 0, scale = 1.2;

const script = document.createElement('script');
script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
script.onload = () => {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    loadPdf();
};
document.head.appendChild(script);

async function loadPdf() {
    try {
        const res = await fetch(PDF_URL);
        if (!res.ok) throw new Error("Fetch failed");
        const base64 = (await res.text()).trim();
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

        pdfDoc = await pdfjsLib.getDocument({ data: bytes }).promise;
        totalPages = pdfDoc.numPages;
        currentPage = 1;
        document.getElementById('pdf-loading').style.display = 'none';
        await renderAllPages();
        updatePageInfo();
    } catch(e) {
        document.getElementById('pdf-loading').textContent = '❌ PDF load failed: ' + e.message;
    }
}

async function renderAllPages() {
    const wrap = document.getElementById('pdf-canvas-wrap');
    wrap.querySelectorAll('canvas, .pdf-ad-wrap').forEach(c => c.remove());
    for (let i = 1; i <= totalPages; i++) {
        const page = await pdfDoc.getPage(i);
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.className = 'pdf-page-canvas';
        canvas.id = 'pdf-page-' + i;
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.userSelect = 'none';
        canvas.style.webkitUserSelect = 'none';
        canvas.style.pointerEvents = 'none';
        wrap.appendChild(canvas);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

        // ہر page کے بعد ad بینر (آخری page کے بعد نہیں)
        if (i < totalPages) {
            const adWrap = document.createElement('div');
            adWrap.className = 'pdf-ad-wrap';
            adWrap.style.cssText = 'width:100%;text-align:center;overflow:hidden;margin:16px 0;padding:10px 0;border-top:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0;background:#f8fafc;border-radius:8px;';
            adWrap.innerHTML = '<script>atOptions={"key":"333dc5bfbee4b34aa13ee95636901b9c","format":"iframe","height":60,"width":468,"params":{}};' + '<' + '/script>' +
                '<script src="https://www.highperformanceformat.com/333dc5bfbee4b34aa13ee95636901b9c/invoke.js">' + '<' + '/script>';
            wrap.appendChild(adWrap);
        }
    }
}
function updatePageInfo() {
    document.getElementById('pdf-page-info').textContent = totalPages + ' pages';
}

function pdfPrev() {
    if (currentPage <= 1) return;
    currentPage--;
    document.getElementById('pdf-page-' + currentPage)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    updatePageInfo();
}

function pdfNext() {
    if (currentPage >= totalPages) return;
    currentPage++;
    document.getElementById('pdf-page-' + currentPage)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    updatePageInfo();
}

// ✅ Right click اور long press بند
document.addEventListener('contextmenu', e => e.preventDefault());
document.addEventListener('DOMContentLoaded', () => {
    const wrap = document.getElementById('pdf-canvas-wrap');
    if (!wrap) return;
    wrap.addEventListener('scroll', () => {
        for (let i = 1; i <= totalPages; i++) {
            const c = document.getElementById('pdf-page-' + i);
            if (!c) continue;
            const rect = c.getBoundingClientRect();
            const wrapRect = wrap.getBoundingClientRect();
            if (rect.top >= wrapRect.top - 50) {
                if (currentPage !== i) { currentPage = i; updatePageInfo(); }
                break;
            }
        }
    });
});

async function pdfDownload() {
    const btn = document.querySelector('.pdf-dl-btn');
    btn.textContent = 'Downloading...';
    btn.disabled = true;
    try {
        const res = await fetch(PDF_URL);
        const base64 = (await res.text()).trim();
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = PDF_NAME;
        document.body.appendChild(a); a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch(e) {
        alert('Download error: ' + e.message);
    } finally {
        btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zm-8 2V5h2v6h1.17L12 13.17 9.83 11H11zm-6 7h14v2H5v-2z"/></svg> Download';
        btn.disabled = false;
    }
}
<\/script>
<script>
(function(){
  function pcBannerStop(){
    var footer = document.querySelector('.site-footer');
    var layout = document.querySelector('.page-layout');
    var banners = document.querySelectorAll('.pc-banner');
    if (!footer || !layout || !banners.length) return;
    var layoutRect = layout.getBoundingClientRect();
    var footerRect = footer.getBoundingClientRect();
    var bannerH = 600;
    var topOffset = 75;
    var hitsFooter = footerRect.top <= topOffset + bannerH;
    banners.forEach(function(b){
      if (hitsFooter) {
        var stopTop = (footerRect.top - layoutRect.top) - bannerH - 10;
        b.style.setProperty('--pc-stop-top', stopTop + 'px');
        b.classList.add('pc-banner-stop');
      } else {
        b.classList.remove('pc-banner-stop');
      }
    });
  }
  window.addEventListener('scroll', pcBannerStop, { passive: true });
  window.addEventListener('resize', pcBannerStop);
  document.addEventListener('DOMContentLoaded', pcBannerStop);
  setTimeout(pcBannerStop, 300);
})();
<\/script>
<!-- WhatsApp Channel Float Button -->
<div id="wa-channel-btn" onclick="window.open('https://whatsapp.com/channel/0029VbCe3Mf2kNFroj9qx223','_blank')" style="position:fixed;bottom:90px;right:16px;z-index:9998;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:4px;animation:waBounce 2s ease-in-out infinite;">
  <div style="background:#25D366;width:54px;height:54px;border-radius:50%;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 14px rgba(37,211,102,0.5);">
    <svg width="28" height="28" viewBox="0 0 24 24" fill="white"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51a12.8 12.8 0 0 0-.57-.01c-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z"/></svg>
  </div>
  <div style="background:#25D366;color:white;font-size:9px;font-weight:800;padding:3px 8px;border-radius:10px;white-space:nowrap;box-shadow:0 2px 8px rgba(37,211,102,0.4);">Join our<br>WhatsApp Channel</div>
</div>
<style>
@keyframes waBounce {
  0%, 100% { transform: translateY(0px); }
  50% { transform: translateY(-8px); }
}
</style>
</body>
</html>`;
}
async function isUserVerified(posterId, env) {
    if (!posterId) return false;

    const cacheKey = `verified:${posterId}`;
    try {
        const cached = await env.JOBS_KV.get(cacheKey, { type: "text" });
        if (cached !== null) return cached === "1";
    } catch(e) {}

    try {
        const res = await fetch(
            `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${posterId}?key=${env.FIREBASE_API_KEY}`
        );
        const json = await res.json();
        const isVerified = json.fields?.isVerified?.booleanValue === true;

        await env.JOBS_KV.put(cacheKey, isVerified ? "1" : "0", { expirationTtl: 604800 });
        return isVerified;
    } catch(e) {
        return false;
    }
}
// ── Helpers ───────────────────────────────────────────────────────────────────
function htmlResponse(html, extra = {}) {
    return new Response(html, {
        status: 200,
        headers: {
            "Content-Type": "text/html;charset=UTF-8",
            "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
            ...extra
        }
    });
}

function errorPage(status, heading, message) {
    return new Response(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>${heading} | Health Jobs Portal</title><meta name="robots" content="noindex"><style>*{margin:0;padding:0;box-sizing:border-box;font-family:-apple-system,sans-serif;}body{background:#f3f2ef;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;}.box{background:white;border-radius:14px;padding:40px 30px;max-width:420px;width:100%;text-align:center;box-shadow:0 4px 20px rgba(0,0,0,0.08);}.icon{font-size:52px;margin-bottom:16px;}h1{font-size:22px;color:#0a66c2;margin-bottom:10px;}p{color:#555;font-size:15px;line-height:1.6;margin-bottom:24px;}a{display:inline-block;padding:12px 28px;background:#0a66c2;color:white;border-radius:24px;text-decoration:none;font-weight:700;font-size:14px;}</style></head><body><div class="box"><div class="icon">${status === 404 ? "🔍" : "⚠️"}</div><h1>${heading}</h1><p>${message}</p><a href="${SITE_URL}/">Browse All Jobs</a></div></body></html>`,
        {
            status,
            headers: {
                "Content-Type": "text/html;charset=UTF-8",
                "Cache-Control": "no-store"
            }
        }
    );
}
