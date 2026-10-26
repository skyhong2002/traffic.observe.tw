# 網站雷達 Logo

以「觀測環、流量刻度、訊號點」建立識別。開放圓環代表持續觀察，高低不同的三道刻度呈現網站流量與技術訊號；橘點是品牌焦點，不表示即時更新或服務狀態。正式中文名稱使用「網站雷達」。

## 檔案

- `logo-horizontal-{dark,light,black,white}.svg`：橫式標準字標，適用網站、報告頁首。
- `logo-stacked-{dark,light,black,white}.svg`：直式組合，適用封面、海報。
- `logo-mark-{dark,light,black,white}.svg`：獨立圖標，適用頭像、浮水印。
- `dark` 是供深色背景使用的霧白字版；`light` 是供淺色背景使用的炭黑字版。SVG 本身均為透明背景。
- `black` 與 `white` 為單色版，適用印刷與反白。
- 深淺底的三種組合各附 4 倍尺寸透明 PNG：橫式 732×216、直式 1136×760；圖標 1024×1024。
- `favicon.svg`、`favicon.ico`：獨立調整線寬的小尺寸圖示。ICO 含 16、32、48、64px。
- `app-icon.svg`、`icon-192.png`、`icon-512.png`、`apple-touch-icon.png`（180px）：炭黑滿版底的手機／應用程式圖示，交由平台裁切圓角。

## 使用規範

1. 保留長寬比，使用深淺底對應版本；不要加陰影、漸層或任意替換橘點顏色。
2. 四周至少保留圖標寬度的 1/8 作為淨空間（64 單位圖標的 8 單位）。
3. 橫式建議以約 183px 寬使用（中文字 30px），窄螢幕仍保留完整站名，直式至少 142px 寬；16–32px 使用 `favicon`，不放中文字標。
4. 深底主色：霧白 `#EDEDED`、觀測橘 `#FB923C`；淺底主色：炭黑 `#18181B`、赭橘 `#C2410C`。建議背景為 `#0A0A0A` 或 `#F6F5F1`。
5. 網站連結的替代文字使用完整名稱；與可讀名稱重複的裝飾圖標使用空白替代文字。

字標採 Noto Serif CJK TC SemiBold（思源宋體／Noto Serif TC 系列），與 tag.observe.tw、blog.observe.tw 的宋體字標呼應，採用 C 版：橫式移除英文網域，中文放大到 30px 並依實際字形垂直置中；直式同步移除網址、放大中文站名。字標已轉成向量路徑，不需要安裝字型，也不依賴外部字型服務。字型授權見 `FONT-LICENSE.txt`。圖形的圓環、刻度及圓點保留為可編輯 SVG 路徑。

可直接開啟 `../../docs/brand/index.html` 查看離線展示、切換橫直排列並下載 SVG。

重產：`python tools/brand-assets.py [NotoSerifCJK-SemiBold.ttc 路徑]`，需要 fontTools、Pillow、rsvg-convert。預設讀取本機 `/usr/share/fonts/noto-cjk/NotoSerifCJK-SemiBold.ttc`，選用 TC 字形，不需要網路或資料庫。
