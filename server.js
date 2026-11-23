const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'vloxy_db.json');

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

if (!fs.existsSync(DB_FILE)) {
    const initialData = { posts: [] };
    fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2));
}

function readDB() {
    try {
        return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) {
        return { posts: [] };
    }
}

function writeDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

app.get('/api/posts', (req, res) => {
    const db = readDB();
    res.json((db.posts || []).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)));
});

app.post('/api/posts', (req, res) => {
    const { author, handle, community, content, verified } = req.body;
    if (!content || !content.trim()) {
        return res.status(400).json({ error: 'المحتوى مطلوب' });
    }

    const db = readDB();
    const newPost = {
        id: Date.now(),
        author: author || 'مستخدم',
        handle: handle || '@user',
        verified: !!verified,
        community: community || 'عام',
        content: content.trim(),
        votes: 1,
        reposts: 0,
        reactions: { like: 0, love: 0, fire: 0, haha: 0 },
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

app.post('/api/posts/:id/react', (req, res) => {
    const { type } = req.body;
    const db = readDB();
    const post = db.posts.find(p => p.id == req.params.id);
    if (!post) return res.status(404).json({ error: 'غير موجود' });

    if (!post.reactions) post.reactions = { like: 0, love: 0, fire: 0, haha: 0 };
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

    post.reposts = (post.reposts || 0) + 1;
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
    const key = (apiKey && apiKey.trim()) || process.env.GEMINI_API_KEY;

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
