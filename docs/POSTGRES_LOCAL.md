# إعداد Postgres محلي للاختبار

1. انسخ ملف المثال إلى ملف بيئة محلي:

```bash
cp .env.postgres.example .env.postgres
```

2. شغّل الحاوية (Docker يجب أن يكون مثبتاً):

```bash
docker compose -f docker-compose.postgres.yml up -d
```

3. تحقق من حالة الحاوية وسجلاتها:

```bash
docker compose -f docker-compose.postgres.yml ps
docker compose -f docker-compose.postgres.yml logs -f
```

4. استخدام `DATABASE_URL` للمزامنة/الدفع (مثلاً مع Drizzle):

```bash
# مثال: تشغيل سكربت الدفع في حزمة DB
pnpm --filter @workspace/db run push
```

ملاحظة: احتفظ بملف `.env.postgres` محلياً وتجنّب رفعه إلى Git. يمكنك تعديل القيم حسب الحاجة.
