# Product image storage

- Product images are public catalog media, not private company-profile/KYC documents.
- The Worker stores image bytes in the dedicated `PRODUCT_IMAGES` Cloudflare KV namespace.
- Neon stores only the stable HTTPS URL in the tenant's `product_images.url` field; it does not store the uploaded binary or a Base64 data URL.
- Product images remain optional; when supplied, the form accepts one or two JPEG, PNG, or WebP images, up to 5 MiB each.
- The public Worker media URL includes the company ID and a random image UUID. It is immutable and cached at the edge for one year.
- Existing clients that still send an image as a Base64 data URL are converted into a KV object and persisted as a URL, so new product records avoid image bytes in Neon while the OTA UI rolls out.
- The public image endpoint serves only the three detected raster formats and uses `X-Content-Type-Options: nosniff`.
