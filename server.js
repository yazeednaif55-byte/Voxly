const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'vloxy_db.json');

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(__dirname));

if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ posts: [], users: {} }, null, 2));
}

function readDB() {
    try {
        const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        return {
            posts: Array.isArray(parsed.posts) ? parsed.posts : [],
            users: parsed.users && typeof parsed.users === 'object' ? parsed.users : {}
        };
    } catch (e) {
        return { posts: [], users: {} };
    }
}

function writeDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function normalizeHandle(h) {
    const clean = (h || '@user').trim();
    if (!clean) return '@user';
    return clean.startsWith('@') ? clean : '@' + clean;
}

function ensureUserRecord(db, handle, fallbackAuthor = 'مستخدم', fallbackAvatar = '') {
    const h = normalizeHandle(handle);
    if (!db.users[h]) {
        db.users[h] = {
            handle: h,
            author: fallbackAuthor || 'مستخدم',
            avatar: fallbackAvatar || '',
            followers: 0,
            bio: ''
        };
    } else {
        if (fallbackAuthor) db.users[h].author = fallbackAuthor;
        if (fallbackAvatar) db.users[h].avatar = fallbackAvatar;
    }
    return db.users[h];
}

app.get('/api/posts', (req, res) => {
    const db = readDB();
    const sorted = [...db.posts].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    res.json(sorted);
});

app.get('/api/users/:handle', (req, res) => {
    const db = readDB();
    const h = normalizeHandle(decodeURIComponent(req.params.handle));
    const userPosts = db.posts.filter(p => normalizeHandle(p.handle) === h);
    const firstPost = userPosts[0];
    const user = ensureUserRecord(
        db,
        h,
        firstPost ? firstPost.author : 'مستخدم',
        firstPost ? firstPost.avatar : ''
    );
    writeDB(db);
    res.json({
        user,
        verified: (user.followers || 0) >= 3000,
        posts: userPosts.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    });
});

app.post('/api/users/profile', (req, res) => {
    const { handle, author, avatar, bio } = req.body;
    const h = normalizeHandle(handle);
    const db = readDB();
    const existing = ensureUserRecord(db, h, author, avatar);
    if (typeof author === 'string' && author.trim()) existing.author = author.trim();
    if (typeof avatar === 'string') existing.avatar = avatar;
    if (typeof bio === 'string') existing.bio = bio.trim();

    db.posts.forEach(p => {
        if (normalizeHandle(p.handle) === h) {
            p.author = existing.author;
            p.avatar = existing.avatar;
            p.followers = existing.followers;
        }
    });

    writeDB(db);
    res.json({ user: existing, verified: (existing.followers || 0) >= 3000 });
});

app.post('/api/users/:handle/follow', (req, res) => {
    const { delta } = req.body; // 1 for follow, -1 for unfollow
    const h = normalizeHandle(decodeURIComponent(req.params.handle));
    const db = readDB();
    const user = ensureUserRecord(db, h);
    const step = Number(delta) === -1 ? -1 : 1;
    user.followers = Math.max(0, (Number(user.followers) || 0) + step);

    const isVerified = user.followers >= 3000;
    db.posts.forEach(p => {
        if (normalizeHandle(p.handle) === h) {
            p.followers = user.followers;
            p.verified = isVerified;
        }
    });

    writeDB(db);
    res.json({ user, verified: isVerified });
});

app.post('/api/posts', (req, res) => {
    const { author, handle, avatar, community, content, mediaType, mediaData } = req.body;
    const hasText = !!(content && content.trim());
    const hasMedia = !!(mediaType && mediaData);

    if (!hasText && !hasMedia) {
        return res.status(400).json({ error: 'أضف نصاً أو صورة أو فيديو للنشر' });
    }

    const db = readDB();
    const h = normalizeHandle(handle);
    const user = ensureUserRecord(db, h, author, avatar);
    const followers = Number(user.followers) || 0;

    const newPost = {
        id: Date.now(),
        author: user.author || 'مستخدم',
        handle: h,
        avatar: user.avatar || '',
        followers,
        verified: followers >= 3000,
        community: community || 'عام',
        content: hasText ? content.trim() : '',
        mediaType: hasMedia ? mediaType : null,
        mediaData: hasMedia ? mediaData : null,
        votes: 1,
        hearts: 0,
        reposts: 0,
        reactions: { like: 0, fire: 0, haha: 0 },
        comments: [],
        timestamp: new Date().toISOString()
    };

    db.posts.unshift(newPost);
    writeDB(db);
    res.status(201).json(newPost);
});

app.post('/api/posts/:id/vote', (req, res) => {
    const { direction } = req.body;
    const db = readDB();
    const post = db.posts.find(p => p.id == req.params.id);
    if (!post) return res.status(404).json({ error: 'غير موجود' });

    if (direction === 'up') post.votes += 1;
    if (direction === 'down') post.votes -= 1;

    writeDB(db);
    res.json(post);
});

app.post('/api/posts/:id/heart', (req, res) => {
    const db = readDB();
    const post = db.posts.find(p => p.id == req.params.id);
    if (!post) return res.status(404).json({ error: 'غير موجود' });

    post.hearts = (Number(post.hearts) || 0) + 1;
    writeDB(db);
    res.json(post);
});

app.post('/api/posts/:id/react', (req, res) => {
    const { type } = req.body;
    const db = readDB();
    const post = db.posts.find(p => p.id == req.params.id);
    if (!post) return res.status(404).json({ error: 'غير موجود' });

    if (!post.reactions) post.reactions = { like: 0, fire: 0, haha: 0 };
    if (post.reactions[type] !== undefined) {
        post.reactions[type] += 1;
    }

    writeDB(db);
    res.json(post);
});

app.post('/api/posts/:id/repost', (req, res) => {
    const db = readDB();
    const post = db.posts.find(p => p.id == req.params.id);
    if (!post) return res.status(404).json({ error: 'غير موجود' });

    post.reposts = (Number(post.reposts) || 0) + 1;
    writeDB(db);
    res.json(post);
});

app.post('/api/posts/:id/comments', (req, res) => {
    const { author, text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'التعليق فارغ' });

    const db = readDB();
    const post = db.posts.find(p => p.id == req.params.id);
    if (!post) return res.status(404).json({ error: 'غير موجود' });

    post.comments.push({
        id: Date.now(),
        author: author || 'مستخدم',
        text: text.trim(),
        timestamp: new Date().toISOString()
    });

    writeDB(db);
    res.status(201).json(post);
});

app.delete('/api/posts/:id', (req, res) => {
    const db = readDB();
    db.posts = db.posts.filter(p => p.id != req.params.id);
    writeDB(db);
    res.json({ success: true });
});

app.post('/api/ai', async (req, res) => {
    const { action, text, apiKey } = req.body;
    const key = (apiKey && apiKey.trim()) || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;

    if (!key) {
        return res.status(400).json({
            requiresApiKey: true,
            error: 'الذكاء الاصطناعي يتطلب مفتاح API. ادخل إلى https://aistudio.google.com/apps ثم أنشئ API وأدخله في الإعدادات أو نافذة الذكاء الاصطناعي.'
        });
    }

    if (!text || !text.trim()) {
        return res.status(400).json({ error: 'اكتب نصاً أولاً.' });
    }

    let promptInstruction = 'حسّن صياغة النص التالي واجعله واضحاً وجذاباً بنفس اللغة:';
    if (action === 'summarize') {
        promptInstruction = 'لخّص النص التالي باختصار ووضوح:';
    } else if (action === 'reply') {
        promptInstruction = 'اقترح رداً مناسباً ومفيداً على النص التالي:';
    }

    try {
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(key)}`;
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [
                    {
                        parts: [
                            { text: `${promptInstruction}\n\n${text.trim()}` }
                        ]
                    }
                ]
            })
        });

        const data = await response.json();

        if (!response.ok) {
            return res.status(response.status).json({
                error: data.error?.message || 'تعذر الاتصال بخدمة الذكاء الاصطناعي، تأكد من صحة مفتاح API.'
            });
        }

        const outputText = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (!outputText) {
            return res.status(500).json({ error: 'لم يتم استلام رد نصي من النموذج.' });
        }

        res.json({ result: outputText });
    } catch (err) {
        res.status(500).json({ error: 'حدث خطأ أثناء الاتصال بواجهة الذكاء الاصطناعي.' });
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Vloxy is running on http://localhost:${PORT}`);
});
