The user supplied these Similarweb screenshots on 2026-11-08 and identified
the site as **tw.stock.yahoo.com**, October 2026, Worldwide / All traffic.
They show publicly reported aggregate traffic, without an account identity.
The TSV fixtures were produced with English Tesseract 7, sparse-text mode,
after enlarging the PNGs to twice their size. Browser integration tests also
recognize the original PNGs, rather than relying only on cached OCR output.

The `extension-*` screenshots were supplied on 2026-11-12. The engagement
card identifies **matsu.idv.tw**, October 2026. Its accompanying country card
is above a separate **Worldwide / Desktop Only** Traffic Sources card.
The country and source cards have independent scopes. Since 2026-11-14,
desktop-only channels import into separate `desktop_*` fields, while all-device
channels stay empty. In the raw TSV the 0.12% Germany share has OCR confidence
below 80; the browser may recover it by re-reading a larger numeric crop.
These TSVs use the same 2x browser-canvas enlargement and sparse-text Tesseract
mode as the importer.

The `s3-*` screenshots were supplied on 2026-11-14 for **s3.com.tw**, October
2026. The second image starts at `Country`, with `Top 5 Countries` cropped out,
and includes Worldwide / Desktop Only sources. Raw OCR loses the decimal in
United States 2.13% and Affiliate 4.67%, yielding 213% and 467%. The browser
test re-reads actual enlarged numeric crops, recovering all five countries and
ten desktop channels; it also imports this second image by itself, preserves
drafts, then fills engagement from the first image. No cloud OCR is used.

`s3-geography-compressed.jpg` derives from the same supplied geography PNG,
resized to 65% (428×832) with browser canvas and encoded as JPEG quality 0.8.
Its TSV uses the importer's 2x enlargement and sparse-text mode (PSM 11).
This transformation reproduces the reported omission: 93.23% remains visible
but the Taiwan label disappears from the first OCR pass. A second full-image
reading with PSM 6 recovers Taiwan. The browser regression verifies the actual
JPEG, on a fresh tab without a draft, as well as both original screenshots in
engagement-first order. Only country shares merge across segmentation modes;
conflicting values are omitted and no remainder calculation supplies Taiwan.
