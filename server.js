const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const VERIFIED_THRESHOLD = 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

app.use(express.json({ limit: '35mb' }));
app.use(express.static(__dirname));

const sseClients = new Set();

function normalizeHandle(h) {
    const clean = String(h || '@user').trim();
    if (!clean) return '@user';
    return clean.startsWith('@') ? clean : '@' + clean;
}

function loadState() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            return {
                posts: Array.isArray(raw.posts) ? raw.posts : [],
                users: raw.users && typeof raw.users === 'object' ? raw.users : {}
            };
        }
    } catch (e) {}
    return { posts: [], users: {} };
}

let state = loadState();

function saveState() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2), 'utf8');
    } catch (e) {}
}

function findExistingAuthorForHandle(handle) {
    if (state.users[handle] && state.users[handle].author && state.users[handle].author !== 'مستخدم') {
        return state.users[handle].author;
    }
    const foundPost = state.posts.find(
        p => normalizeHandle(p.handle) === handle && p.author && p.author !== 'مستخدم'
    );
    if (foundPost) return foundPost.author;
    if (state.users[handle] && state.users[handle].author) {
        return state.users[handle].author;
    }
    return null;
}

function findExistingAvatarForHandle(handle) {
    if (state.users[handle] && state.users[handle].avatar) {
        return state.users[handle].avatar;
    }
    const foundPost = state.posts.find(
        p => normalizeHandle(p.handle) === handle && p.avatar
    );
    return foundPost ? foundPost.avatar : '';
}

function ensureUser(rawHandle, fallbackAuthor = null, fallbackAvatar = null) {
    const handle = normalizeHandle(rawHandle);
    const existing = state.users[handle];
    const resolvedAuthor =
        (fallbackAuthor && String(fallbackAuthor).trim() && String(fallbackAuthor).trim() !== 'مستخدم')
            ? String(fallbackAuthor).trim()
            : (findExistingAuthorForHandle(handle) || (existing && existing.author) || (fallbackAuthor && String(fallbackAuthor).trim()) || 'مستخدم');

    const resolvedAvatar =
        (fallbackAvatar !== null && fallbackAvatar !== undefined && String(fallbackAvatar).trim() !== '')
            ? String(fallbackAvatar)
            : (findExistingAvatarForHandle(handle) || (existing && existing.avatar) || '');

    if (!existing) {
        state.users[handle] = {
            handle,
            author: resolvedAuthor,
            avatar: resolvedAvatar,
            followers: 0
        };
    } else {
        existing.author = resolvedAuthor;
        if (resolvedAvatar) existing.avatar = resolvedAvatar;
        existing.followers = Math.max(0, Number(existing.followers) || 0);
    }

    return state.users[handle];
}

function enrichPost(post) {
    const handle = normalizeHandle(post.handle);
    const u = ensureUser(handle, post.author, post.avatar);
    const followers = Math.max(0, Number(u.followers) || 0);
    return {
        ...post,
        handle: u.handle,
        author: u.author,
        avatar: u.avatar,
        followers,
        verified: followers >= VERIFIED_THRESHOLD,
        votes: Number(post.votes) || 0,
        hearts: Math.max(0, Number(post.hearts) || 0),
        reposts: Math.max(0, Number(post.reposts) || 0),
        reactions: {
            like: Number(post.reactions?.like) || 0,
            fire: Number(post.reactions?.fire) || 0,
            haha: Number(post.reactions?.haha) || 0
        },
        comments: Array.isArray(post.comments) ? post.comments : []
    };
}

function getAllEnrichedPosts() {
    return state.posts
        .map(enrichPost)
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

function broadcast(payload) {
    const data = `event: sync\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of sseClients) {
        try {
            res.write(data);
        } catch (e) {
            sseClients.delete(res);
        }
    }
}

app.get('/api/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    sseClients.add(res);
    res.write(`event: sync\ndata: ${JSON.stringify({ type: 'init', posts: getAllEnrichedPosts() })}\n\n`);

    const keepAlive = setInterval(() => {
        try {
            res.write(`: ping\n\n`);
        } catch (e) {
            clearInterval(keepAlive);
            sseClients.delete(res);
        }
    }, 15000);

    req.on('close', () => {
        clearInterval(keepAlive);
        sseClients.delete(res);
    });
});

app.get('/api/posts', (req, res) => {
    res.json(getAllEnrichedPosts());
});

app.post('/api/posts', (req, res) => {
    const body = req.body || {};
    const handle = normalizeHandle(body.handle);
    const user = ensureUser(handle, body.author, body.avatar);

    const newPost = enrichPost({
        id: Date.now() + Math.floor(Math.random() * 1000),
        author: user.author,
        handle: user.handle,
        avatar: user.avatar,
        community: body.community || 'عام',
        content: String(body.content || '').trim(),
        mediaType: body.mediaType || null,
        mediaData: body.mediaData || null,
        votes: 1,
        hearts: 0,
        reposts: 0,
        reactions: { like: 0, fire: 0, haha: 0 },
        comments: [],
        timestamp: new Date().toISOString()
    });

    state.posts.unshift(newPost);
    saveState();
    broadcast({ type: 'new_post', post: newPost });
    res.status(201).json(newPost);
});

app.post('/api/posts/:id/vote', (req, res) => {
    const idx = state.posts.findIndex(p => String(p.id) === String(req.params.id));
    if (idx === -1) return res.status(404).json({ error: 'المنشور غير موجود' });

    const dir = req.body?.direction === 'down' ? -1 : 1;
    state.posts[idx].votes = (Number(state.posts[idx].votes) || 0) + dir;
    const updated = enrichPost(state.posts[idx]);
    state.posts[idx] = updated;
    saveState();
    broadcast({ type: 'post_update', post: updated });
    res.json(updated);
});

app.post('/api/posts/:id/heart', (req, res) => {
    const idx = state.posts.findIndex(p => String(p.id) === String(req.params.id));
    if (idx === -1) return res.status(404).json({ error: 'المنشور غير موجود' });

    const delta = Number(req.body?.delta) === -1 ? -1 : 1;
    state.posts[idx].hearts = Math.max(0, (Number(state.posts[idx].hearts) || 0) + delta);
    const updated = enrichPost(state.posts[idx]);
    state.posts[idx] = updated;
    saveState();
    broadcast({ type: 'post_update', post: updated });
    res.json(updated);
});

app.post('/api/posts/:id/react', (req, res) => {
    const idx = state.posts.findIndex(p => String(p.id) === String(req.params.id));
    if (idx === -1) return res.status(404).json({ error: 'المنشور غير موجود' });

    const rType = ['like', 'fire', 'haha'].includes(req.body?.type) ? req.body.type : 'like';
    state.posts[idx].reactions = {
        like: Number(state.posts[idx].reactions?.like) || 0,
        fire: Number(state.posts[idx].reactions?.fire) || 0,
        haha: Number(state.posts[idx].reactions?.haha) || 0
    };
    state.posts[idx].reactions[rType] += 1;

    const updated = enrichPost(state.posts[idx]);
    state.posts[idx] = updated;
    saveState();
    broadcast({ type: 'post_update', post: updated });
    res.json(updated);
});

app.post('/api/posts/:id/repost', (req, res) => {
    const idx = state.posts.findIndex(p => String(p.id) === String(req.params.id));
    if (idx === -1) return res.status(404).json({ error: 'المنشور غير موجود' });

    state.posts[idx].reposts = (Number(state.posts[idx].reposts) || 0) + 1;
    const updated = enrichPost(state.posts[idx]);
    state.posts[idx] = updated;
    saveState();
    broadcast({ type: 'post_update', post: updated });
    res.json(updated);
});

app.post('/api/posts/:id/comments', (req, res) => {
    const idx = state.posts.findIndex(p => String(p.id) === String(req.params.id));
    if (idx === -1) return res.status(404).json({ error: 'المنشور غير موجود' });

    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'التعليق فارغ' });

    state.posts[idx].comments = Array.isArray(state.posts[idx].comments) ? state.posts[idx].comments : [];
    state.posts[idx].comments.push({
        id: Date.now() + Math.floor(Math.random() * 1000),
        author: String(req.body?.author || 'مستخدم').trim() || 'مستخدم',
        text,
        timestamp: new Date().toISOString()
    });

    const updated = enrichPost(state.posts[idx]);
    state.posts[idx] = updated;
    saveState();
    broadcast({ type: 'post_update', post: updated });
    res.json(updated);
});

app.delete('/api/posts/:id', (req, res) => {
    const before = state.posts.length;
    state.posts = state.posts.filter(p => String(p.id) !== String(req.params.id));
    if (state.posts.length !== before) {
        saveState();
        broadcast({ type: 'delete_post', id: req.params.id });
    }
    res.json({ ok: true });
});

app.post('/api/users/profile', (req, res) => {
    const body = req.body || {};
    const handle = normalizeHandle(body.handle);
    const existing = ensureUser(handle, body.author, body.avatar);

    if (body.author && String(body.author).trim()) {
        existing.author = String(body.author).trim();
    }
    if (body.avatar !== undefined) {
        existing.avatar = String(body.avatar || '');
    }

    state.posts = state.posts.map(p => {
        if (normalizeHandle(p.handle) === handle) {
            return enrichPost({ ...p, author: existing.author, avatar: existing.avatar });
        }
        return enrichPost(p);
    });

    saveState();
    const verified = existing.followers >= VERIFIED_THRESHOLD;
    broadcast({ type: 'profile', handle, user: { ...existing, verified }, verified });
    res.json({ user: { ...existing, verified }, verified });
});

app.get('/api/users/:handle', (req, res) => {
    const handle = normalizeHandle(decodeURIComponent(req.params.handle));
    const user = ensureUser(handle);
    const verified = user.followers >= VERIFIED_THRESHOLD;
    const userPosts = getAllEnrichedPosts().filter(p => normalizeHandle(p.handle) === handle);
    res.json({
        user: { ...user, verified },
        verified,
        posts: userPosts
    });
});

app.post('/api/users/:handle/follow', (req, res) => {
    const handle = normalizeHandle(decodeURIComponent(req.params.handle));
    const user = ensureUser(handle, req.body?.author, req.body?.avatar);
    const delta = Number(req.body?.delta) === -1 ? -1 : 1;

    user.followers = Math.max(0, (Number(user.followers) || 0) + delta);
    const verified = user.followers >= VERIFIED_THRESHOLD;

    state.posts = state.posts.map(p => {
        if (normalizeHandle(p.handle) === handle) {
            return enrichPost({ ...p, author: user.author, avatar: user.avatar, followers: user.followers, verified });
        }
        return enrichPost(p);
    });

    saveState();
    broadcast({ type: 'follow', handle, user: { ...user, verified }, verified });
    res.json({ user: { ...user, verified }, verified });
});

app.post('/api/ai', async (req, res) => {
    const { action, text, apiKey } = req.body || {};
    if (!apiKey || !String(apiKey).trim()) {
        return res.status(400).json({ error: 'يرجى إدخال مفتاح Gemini API أولاً.' });
    }

    const promptPrefix = action === 'summarize'
        ? 'لخص النص التالي بإيجاز ووضوح باللغة العربية:\n'
        : 'أعد صياغة النص التالي بأسلوب جذاب وواضح باللغة العربية:\n';

    try {
        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(String(apiKey).trim())}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: `${promptPrefix}${String(text || '')}` }] }]
                })
            }
        );

        const data = await response.json();
        if (!response.ok) {
            return res.status(response.status).json({
                error: data?.error?.message || 'تعذر الاتصال بخدمة الذكاء الاصطناعي.'
            });
        }

        const result =
            data?.candidates?.[0]?.content?.parts
                ?.map(part => part.text || '')
                .join('')
                .trim() || 'لم يتم إرجاع نص.';

        res.json({ result });
    } catch (e) {
        res.status(500).json({ error: 'حدث خطأ أثناء معالجة طلب الذكاء الاصطناعي.' });
    }
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Vloxy server running on http://localhost:${PORT}`);
});
