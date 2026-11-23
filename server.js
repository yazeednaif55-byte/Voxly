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
    const initialData = {
        posts: [
            {
                id: 1700000000001,
                author: "فريق Vloxy",
                handle: "@vloxy",
                verified: true,
                community: "عام",
                content: "أهلاً بك في Vloxy! منصة تواصل اجتماعي شاملة تجمع بين تغريدات X، تصويت ومجتمعات Reddit، وتفاعلات Facebook في واجهة واحدة سريعة.\n\nجرب الذكاء الاصطناعي المدمج أو افتح محادثات Nexus Messenger من القائمة!",
                votes: 42,
                reposts: 7,
                reactions: { like: 15, love: 9, fire: 12, haha: 2 },
                comments: [
                    {
                        id: 1700000000002,
                        author: "يزيد",
                        text: "تصميم رهيب وسريع جداً!",
                        timestamp: new Date().toISOString()
                    }
                ],
                timestamp: new Date().toISOString()
            }
        ]
    };
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

// جلب المنشورات
app.get('/api/posts', (req, res) => {
    const db = readDB();
    res.json(db.posts.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)));
});

// نشر منشور جديد
app.post('/api/posts', (req, res) => {
    const { author, handle, community, content, verified } = req.body;
    if (!content || !content.trim()) {
        return res.status(400).json({ error: 'المحتوى مطلوب' });
    }

    const db = readDB();
    const newPost = {
        id: Date.now(),
        author: author || 'مستخدم Vloxy',
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

// التصويت (Reddit Style)
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

// التفاعلات المتعددة (Facebook Style)
app.post('/api/posts/:id/react', (req, res) => {
    const { type } = req.body; // like, love, fire, haha
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

// إعادة النشر (X Style)
app.post('/api/posts/:id/repost', (req, res) => {
    const db = readDB();
    const post = db.posts.find(p => p.id == req.params.id);
    if (!post) return res.status(404).json({ error: 'غير موجود' });

    post.reposts = (post.reposts || 0) + 1;
    writeDB(db);
    res.json(post);
});

// التعليقات
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

// حذف منشور
app.delete('/api/posts/:id', (req, res) => {
    const db = readDB();
    db.posts = db.posts.filter(p => p.id != req.params.id);
    writeDB(db);
    res.json({ success: true });
});

// مساعد Vloxy AI الذكي (معالجة النصوص، التحسين، التلخيص)
app.post('/api/ai', (req, res) => {
    const { action, text } = req.body;
    if (!text || !text.trim()) {
        return res.json({ result: "اكتب نصاً أولاً لكي أتمكن من مساعدتك!" });
    }

    const clean = text.trim();
    let result = "";

    if (action === 'enhance') {
        result = ` نسخة محسّنة:\n"${clean}"\n\n شاركونا آراءكم في التعليقات! #Vloxy #نقاش`;
    } else if (action === 'summarize') {
        const words = clean.split(/\s+/);
        const summary = words.length > 15 ? words.slice(0, 15).join(' ') + '...' : clean;
        result = ` ملخص Vloxy AI:\nالفكرة الأساسية تدور حول: "${summary}" — منشور يستحق التفاعل والنقاش.`;
    } else if (action === 'reply') {
        result = `طرح جميل ومثير للاهتمام! أتفق معك تماماً في هذه النقطة، وبانتظار تفاصيل أكثر `;
    } else {
        result = ` اقتراح ذكي: يمكنك إضافة سؤال في نهاية منشورك لزيادة التفاعل بنسبة أكبر.`;
    }

    res.json({ result });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Vloxy is running on http://localhost:${PORT}`);
});
