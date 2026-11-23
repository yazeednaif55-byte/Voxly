const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const VERIFIED_THRESHOLD = 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(__dirname));

let state = {
    posts: [],
    users: {}
};

function normalizeHandle(raw) {
    const clean = String(raw || '').trim();
    if (!clean) return '@user';
    return clean.startsWith('@') ? clean : '@' + clean;
}

function extractHashtags(text) {
    const matches = String(text || '').match(/#[\p{L}\p{N}_]+/gu) || [];
    return Array.from(new Set(matches.map(tag => tag.trim())));
}

function calcHashtagViews(hashtags, baseViews = 0) {
    const tagCount = Array.isArray(hashtags) ? hashtags.length : 0;
    const hashtagBoost = tagCount * (tagCount + 1) * 45;
    return Math.max(0, Number(baseViews) || 0) + hashtagBoost;
}

function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            if (Array.isArray(raw)) {
                state.posts = raw;
            } else if (raw && typeof raw === 'object') {
                state.posts = Array.isArray(raw.posts) ? raw.posts : [];
                state.users = raw.users && typeof raw.users === 'object' ? raw.users : {};
            }
        }
    } catch (e) {
        state = { posts: [], users: {} };
    }
}

function saveData() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2), 'utf8');
    } catch (e) {}
}

function ensureUser(handle, author, avatar) {
    const h = normalizeHandle(handle);
    if (!state.users[h]) {
        state.users[h] = {
            handle: h,
            author: (author && String(author).trim()) || 'مستخدم',
            avatar: avatar || '',
            followers: 0
        };
    } else {
        if (author && String(author).trim() && String(author).trim() !== 'مستخدم') {
            state.users[h].author = String(author).trim();
        }
        if (avatar !== undefined) {
            state.users[h].avatar = avatar || '';
        }
    }
    return state.users[h];
}

function enrichPost(post) {
    const h = normalizeHandle(post.handle);
    const user = state.users[h];
    const followers = user ? Math.max(0, Number(user.followers) || 0) : Math.max(0, Number(post.followers) || 0);
    const hashtags = Array.isArray(post.hashtags) && post.hashtags.length
        ? post.hashtags
        : extractHashtags(post.content);

    const rawViews = Math.max(10, Number(post.views) || 120);
    const totalViews = calcHashtagViews(hashtags, rawViews);

    return {
        ...post,
        handle: h,
        author: (user && user.author) || post.author || 'مستخدم',
        avatar: (user && user.avatar) || post.avatar || '',
        followers,
        verified: followers >= VERIFIED_THRESHOLD,
        isShort: Boolean(post.isShort || post.mediaType === 'video'),
        hashtags,
        views: totalViews,
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

const sseClients = new Set();

function broadcastEvent(payload) {
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of sseClients) {
        try {
            res.write(data);
        } catch (e) {
            sseClients.delete(res);
        }
    }
}

app.get('/api/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const enrichedPosts = state.posts.map(enrichPost);
    res.write(`data: ${JSON.stringify({ type: 'init', posts: enrichedPosts })}\n\n`);
    sseClients.add(res);

    req.on('close', () => {
        sseClients.delete(res);
    });
});

app.get('/api/posts', (req, res) => {
    const sorted = [...state.posts]
        .map(enrichPost)
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    res.json(sorted);
});

app.post('/api/posts', (req, res) => {
    const { author, handle, avatar, community, content, mediaType, mediaData, isShort } = req.body || {};
    const text = String(content || '').trim();
    if (!text && !mediaData) {
        return res.status(400).json({ error: 'المحتوى فارغ' });
    }

    const h = normalizeHandle(handle);
    const user = ensureUser(h, author, avatar);
    const hashtags = extractHashtags(text);
    const initialViews = calcHashtagViews(hashtags, 150);

    const post = enrichPost({
        id: Date.now() + Math.floor(Math.random() * 1000),
        author: user.author,
        handle: h,
        avatar: user.avatar,
        community: String(community || 'عام').trim() || 'عام',
        content: text,
        mediaType: mediaType || null,
        mediaData: mediaData || null,
        isShort: Boolean(isShort || mediaType === 'video'),
        hashtags,
        views: initialViews,
        votes: 1,
        hearts: 0,
        reposts: 0,
        reactions: { like: 0, fire: 0, haha: 0 },
        comments: [],
        timestamp: new Date().toISOString()
    });

    state.posts.unshift(post);
    saveData();
    broadcastEvent({ type: 'new_post', post });
    res.status(201).json(post);
});

app.post('/api/posts/:id/vote', (req, res) => {
    const post = state.posts.find(p => String(p.id) === String(req.params.id));
    if (!post) return res.status(404).json({ error: 'المنشور غير موجود' });
    const delta = req.body?.direction === 'down' ? -1 : 1;
    post.votes = (Number(post.votes) || 0) + delta;
    const updated = enrichPost(post);
    saveData();
    broadcastEvent({ type: 'post_update', post: updated });
    res.json(updated);
});

app.post('/api/posts/:id/heart', (req, res) => {
    const post = state.posts.find(p => String(p.id) === String(req.params.id));
    if (!post) return res.status(404).json({ error: 'المنشور غير موجود' });
    const delta = Number(req.body?.delta) === -1 ? -1 : 1;
    post.hearts = Math.max(0, (Number(post.hearts) || 0) + delta);
    const updated = enrichPost(post);
    saveData();
    broadcastEvent({ type: 'post_update', post: updated });
    res.json(updated);
});

app.post('/api/posts/:id/react', (req, res) => {
    const post = state.posts.find(p => String(p.id) === String(req.params.id));
    if (!post) return res.status(404).json({ error: 'المنشور غير موجود' });
    const type = ['like', 'fire', 'haha'].includes(req.body?.type) ? req.body.type : 'like';
    post.reactions = post.reactions || { like: 0, fire: 0, haha: 0 };
    post.reactions[type] = (Number(post.reactions[type]) || 0) + 1;
    const updated = enrichPost(post);
    saveData();
    broadcastEvent({ type: 'post_update', post: updated });
    res.json(updated);
});

app.post('/api/posts/:id/repost', (req, res) => {
    const post = state.posts.find(p => String(p.id) === String(req.params.id));
    if (!post) return res.status(404).json({ error: 'المنشور غير موجود' });
    post.reposts = (Number(post.reposts) || 0) + 1;
    const updated = enrichPost(post);
    saveData();
    broadcastEvent({ type: 'post_update', post: updated });
    res.json(updated);
});

app.post('/api/posts/:id/comments', (req, res) => {
    const post = state.posts.find(p => String(p.id) === String(req.params.id));
    if (!post) return res.status(404).json({ error: 'المنشور غير موجود' });
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'التعليق فارغ' });

    post.comments = Array.isArray(post.comments) ? post.comments : [];
    post.comments.push({
        id: Date.now(),
        author: String(req.body?.author || 'مستخدم').trim() || 'مستخدم',
        text,
        timestamp: new Date().toISOString()
    });

    const updated = enrichPost(post);
    saveData();
    broadcastEvent({ type: 'post_update', post: updated });
    res.json(updated);
});

app.delete('/api/posts/:id', (req, res) => {
    const idStr = String(req.params.id);
    const before = state.posts.length;
    state.posts = state.posts.filter(p => String(p.id) !== idStr);
    if (state.posts.length === before) {
        return res.status(404).json({ error: 'المنشور غير موجود' });
    }
    saveData();
    broadcastEvent({ type: 'delete_post', id: req.params.id });
    res.json({ ok: true, id: req.params.id });
});

app.get('/api/users/:handle', (req, res) => {
    const h = normalizeHandle(decodeURIComponent(req.params.handle || ''));
    const user = ensureUser(h);
    const userPosts = state.posts
        .map(enrichPost)
        .filter(p => normalizeHandle(p.handle) === h)
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    res.json({ user, posts: userPosts });
});

app.post('/api/users/profile', (req, res) => {
    const h = normalizeHandle(req.body?.handle);
    const user = ensureUser(h, req.body?.author, req.body?.avatar);
    saveData();
    broadcastEvent({ type: 'profile', handle: h, user });
    res.json({ user });
});

app.post('/api/users/:handle/follow', (req, res) => {
    const h = normalizeHandle(decodeURIComponent(req.params.handle || ''));
    const user = ensureUser(h, req.body?.author, req.body?.avatar);
    const delta = Number(req.body?.delta) === -1 ? -1 : 1;
    user.followers = Math.max(0, (Number(user.followers) || 0) + delta);
    saveData();
    broadcastEvent({ type: 'follow', handle: h, user });
    res.json({ user });
});

app.post('/api/ai', async (req, res) => {
    const { action, text, apiKey } = req.body || {};
    const key = String(apiKey || process.env.GEMINI_API_KEY || '').trim();
    const inputText = String(text || '').trim();

    if (!inputText) {
        return res.status(400).json({ error: 'أدخل نصاً أولاً.' });
    }
    if (!key) {
        return res.status(400).json({ error: 'يرجى إدخال مفتاح Gemini API أولاً.' });
    }

    const prompt = action === 'summarize'
        ? `لخص النص التالي بإيجاز ووضوح باللغة العربية:\n\n${inputText}`
        : `أعد صياغة النص التالي بأسلوب واضح وجذاب باللغة العربية مع الحفاظ على معناه:\n\n${inputText}`;

    try {
        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(key)}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }]
                })
            }
        );

        const data = await response.json();
        if (!response.ok) {
            return res.status(response.status).json({
                error: data?.error?.message || 'تعذر الاتصال بخدمة الذكاء الاصطناعي.'
            });
        }

        const resultText = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || 'لم يتم إرجاع نص.';
        res.json({ result: resultText });
    } catch (err) {
        res.status(500).json({ error: 'حدث خطأ أثناء معالجة طلب الذكاء الاصطناعي.' });
    }
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

loadData();
app.listen(PORT, () => {
    console.log(`Vloxy server running on http://localhost:${PORT}`);
});
