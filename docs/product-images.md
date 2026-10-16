# Product image storage

Product images are public catalog media, not private company-profile or KYC documents. The Merchant app sends one or two JPEG, PNG, or WebP files (up to 5 MiB each) to the Tager Worker as multipart form data. Cloudinary credentials are never included in the web or mobile app.

When all three Worker secrets are configured, the Worker signs the Cloudinary Upload API request server-side, uploads the image, and saves only Cloudinary's HTTPS `secure_url` in Neon (`product_images.url` and the primary `metadata.image`). The hourly product-catalog snapshot then carries those links to the customer app.

Existing KV-backed images remain available at their immutable Worker media URLs. The public media endpoint stays in place, so no existing image needs to be migrated for it to continue displaying. During rollout, if none of the Cloudinary secrets are set, uploads use the existing KV path. If only some of the secrets are set, the Worker rejects image uploads rather than silently using a partial integration.

To route new uploads to Cloudinary, configure `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET` as GitHub Actions secrets in `ahn90073-pixel/tagerbackend`. The workflow passes them to the Worker only when all three exist. Never commit the values or place the API secret in the client app. The Worker verifies actual file signatures, enforces image-count and size limits, and accepts only JPEG, PNG, and WebP.
