# Telegram বট — netlify

## কী আছে
- bot.js — বটের মূল কোড
- netlify/functions/telegram.js — হোস্টিংয়ের সংযোগ
- netlify.toml — /tg ও /api/* পথ ঠিক করার নিয়ম
- package.json — দরকারি প্যাকেজ

## ধাপ
1. GitHub-এ নতুন repository খুলে এই ফোল্ডারের সব ফাইল আপলোড করুন।
2. netlify.com → Add new site → Import an existing project → repo বাছুন → Deploy।
3. Environment variables-এ বসান: TELEGRAM_BOT_TOKEN = BotFather-এর token, WEBHOOK_SECRET = অ্যাডমিন প্যানেলের bot key।
4. Netlify Blobs এমনিতেই আছে — কোনো আলাদা ডেটাবেস কিনতে হবে না।
5. ডিপ্লয়ের ঠিকানা (https://xxx.netlify.app) কপি করে অ্যাডমিন প্যানেলের Worker URL ঘরে বসান, একই token ও key দিয়ে “সেভ ও বট যুক্ত করুন” চাপুন।
6. Telegram-এ বটে /start দিন।

কোনো Base44 ফাংশন বা ইন্টিগ্রেশন ক্রেডিট লাগে না। token ও key কাউকে পাঠাবেন না।
