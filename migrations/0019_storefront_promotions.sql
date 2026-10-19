BEGIN;

CREATE TABLE IF NOT EXISTS public.storefront_promotions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  subtitle TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  cta_label TEXT NOT NULL DEFAULT 'تسوق الآن',
  target_url TEXT NOT NULL DEFAULT '/',
  media_url TEXT NOT NULL,
  media_key TEXT,
  media_type TEXT NOT NULL CHECK (media_type IN ('image', 'video')),
  theme TEXT NOT NULL DEFAULT 'blue' CHECK (theme IN ('blue', 'orange', 'slate', 'violet')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS storefront_promotions_active_order_idx
  ON public.storefront_promotions (is_active, sort_order, created_at);

INSERT INTO public.storefront_promotions (
  id,
  title,
  subtitle,
  description,
  cta_label,
  media_url,
  media_type,
  theme,
  sort_order
) VALUES
  (
    '00000000-0000-4000-8000-000000000001',
    'تخفيضات الموسم الكبرى',
    'خصومات تصل إلى 50%',
    'تسوق أحدث المنتجات بأسعار لا تقبل المنافسة — شحن مجاني لجميع المحافظات',
    'تسوق الآن',
    'https://images.pexels.com/photos/5625003/pexels-photo-5625003.jpeg?auto=compress&cs=tinysrgb&h=650&w=940',
    'image',
    'blue',
    0
  ),
  (
    '00000000-0000-4000-8000-000000000002',
    'إلكترونيات بأسعار مذهلة',
    'وصل حديثاً - أحدث الموبايلات واللابتوبات',
    'اكتشف مجموععتنا الواسعة من الهواتف الذكية واللابتوبات بضمان رسمي وشحن سريع',
    'اكتشف المزيد',
    'https://images.pexels.com/photos/36680544/pexels-photo-36680544.jpeg?auto=compress&cs=tinysrgb&h=650&w=940',
    'image',
    'orange',
    1
  ),
  (
    '00000000-0000-4000-8000-000000000003',
    'أزياء وموضة',
    'مجموعة الشتاء الجديدة 2026',
    'أحدث صيحات الموضة بأقوى التخفيضات — استبدال مجاني خلال 14 يوم',
    'تصفح المجموعة',
    'https://images.pexels.com/photos/8743972/pexels-photo-8743972.jpeg?auto=compress&cs=tinysrgb&h=650&w=940',
    'image',
    'slate',
    2
  )
ON CONFLICT (id) DO NOTHING;

COMMIT;
