# 🎨 AI Görsel Üretim & Sprite Özelleştirme Rehberi (Kanlı Ay - 2D Top-Down)

Bu oyun **hibrit görsel altyapısı** ile çalışır. İlk görseller yerleşik AI ile otomatik üretilmiş ve şeffaf PNG haline getirilmiştir. İstersen aşağıdaki en iyi görsel AI araçlarını kullanarak kendi tasarımlarını üretebilir, doğrudan oyun içindeki **"🎨 AI Görsel & Prompt Rehberi"** ekranından sürükle-bırak ile anında oyuna aktarabilirsin!

---

## 🏆 Bu İş İçin En İyi 4 Görsel AI Aracı ve Kullanım Alanları

1. **Leonardo.ai (`Phoenix` veya `AlbedoBase XL` modeli + *Transparent PNG* özelliği)**
   - **Ne İçin En İyisi:** *Darkwood* / *Don't Starve* tarzı karanlık gotik, el çizimi 2D kuş bakışı karakterler ve objeler.
   - **İpucu:** Sağ panelden **"Transparency (Transparent PNG)"** seçeneğini açın veya arka planı düz yeşil (`#00FF00`) isteyin. Oyun içi yükleyicimiz yeşil veya düz arka planları otomatik temizler!

2. **PixelLab.ai (Pixel Art & Çok Yönlü Sprite Sheet İçin En İyisi)**
   - **Ne İçin En İyisi:** Karakterin 4 veya 8 yöne bakmasını ve yürüme animasyon kareleri üretmesini istiyorsanız.
   - **İpucu:** *Top-down 2D RPG / Horror* şablonunu seçip `64x64` veya `128x128` sprite üretebilirsiniz.

3. **Midjourney v6.1 (En Yüksek Atmosfer ve Zemin Tileset Kalitesi)**
   - **Ne İçin En İyisi:** Kusursuz tekrar eden zemin kaplamaları (`--tile` parametresi) ve yüksek detaylı gotik harita dokuları.

4. **Recraft V3 (UI, Yetenek / Perk İkonları ve Keskin Vektör Öğeler İçin)**
   - **Ne İçin En İyisi:** *Dead by Daylight* tarzı eşkenar dörtgen (diamond) yetenek ikonları ve net silhouette objeler.

---

## 📋 Kopyala-Yapıştır Hazır Promptlar

> **Önemli Ayar:** Karakterlerin oyun içinde dönme yönüne tam oturması için kuş bakışı karakterlerin **yukarı (North / 12 yönü)** veya **doğrudan aşağıdan bakıldığında yukarı doğru** hizalı olması idealdir.

### 1. Kurt Adam (Werewolf) — Normal & Kanlı Öfke Modu
* **Prompt:**
  `Top-down orthographic 2D game sprite of a terrifying dark gothic werewolf monster seen directly from above, dark ragged fur, glowing crimson eyes, outstretched sharp claws, Darkwood and Don't Starve hand-drawn dark gothic art style, isolated centered on solid #00FF00 chroma green background, no drop shadow, clean edges`
* **Negative Prompt (Leonardo / SD):**
  `side view, isometric, 3d render, perspective angle, text, watermark, multiple characters, blurry, background scenery`

### 2. Köylüler (4 Farklı Karakter Varyasyonu: Fenerci, Avcı, Şifacı, Demirci)
* **Prompt (Fenerci Köylü):**
  `Top-down orthographic 2D game sprite of a medieval gothic villager survivor seen directly from above, wearing a tattered dark hooded cloak and holding a warm glowing iron lantern, Darkwood hand-drawn dark horror art style, isolated centered on solid #00FF00 chroma green background, no drop shadow, clean edges`
* **Prompt (Şifacı / Avcı Varyasyonu için ek):**
  `...carrying a leather satchel and herbal bandages...` veya `...carrying a wooden crossbow on the back...`
* **Negative Prompt:**
  `side view, isometric, 3d render, anime, bright cartoon, text, watermark, ground shadow`

### 3. Kutsal Tılsım / Jeneratör (Bozuk & Tamir Edilmiş)
* **Prompt:**
  `Top-down orthographic 2D game prop of an ancient gothic stone runic altar generator with brass clockwork gears and glowing cyan arcane runes seen directly from above, Darkwood hand-drawn dark gothic style, isolated centered on solid #00FF00 background, clean silhouette`
* **Negative Prompt:**
  `isometric, side angle, modern sci-fi, text, blurry`

### 4. Kurban Kafesi / Kanca Sunağı (Sacrificial Cage)
* **Prompt:**
  `Top-down orthographic 2D game prop of a sinister gothic wrought-iron sacrificial cage with heavy rusted chains and iron spikes seen directly from above, dark horror hand-drawn style, isolated centered on solid #00FF00 background, clean edges`

### 5. Devrilebilir Ahşap Barikat (Pallet) & Saklanma Dolabı (Locker)
* **Barikat Prompt:**
  `Top-down orthographic 2D game prop of a rough medieval wooden barricade pallet reinforced with iron nails and rope, seen directly from above, dark gothic hand-drawn art style, isolated on solid #00FF00 background`
* **Dolap Prompt:**
  `Top-down orthographic 2D game prop of an antique dark oak gothic wardrobe closet with tarnished iron hinges seen directly from above, Darkwood style, isolated on solid #00FF00 background`

### 6. Çıkış Kapısı (Exit Gate) & Karanlık Orman Zemin Tileset
* **Zemin Tileset (Midjourney'de sonuna `--tile` ekleyin):**
  `Top-down orthographic seamless 2D game texture of a dark gothic forest floor, damp dark soil, mossy ancient cobblestones, dead roots and fallen leaves, Darkwood hand-drawn horror game style, flat lighting, seamless tileable --tile`
* **Çıkış Kapısı:**
  `Top-down orthographic 2D game prop of massive gothic wrought-iron exit gates with stone pillars and red/green signal lanterns, seen directly from above, isolated on solid #00FF00 background`

### 7. Yetenek (Perk) İkonları (Recraft V3 / Flux)
* **Prompt:**
  `Dead by Daylight style gothic horror perk icon inside a dark diamond frame, silver lantern beam piercing darkness / crimson wolf howling under blood moon, minimal high-contrast chalk and ink engraving style, dark obsidian background, crisp vector-like lines`

---

## 🔄 Ürettiğiniz Görselleri Oyuna Nasıl Eklersiniz?

### Yöntem 1: Oyun İçi Anında Yükleme (En Kolay)
1. Oyunu açın (`http://localhost:8080`).
2. Lobide veya oyun içi menüde **"🎨 AI Görsel & Prompt Rehberi"** butonuna tıklayın.
3. Açılan panelde **Kurt**, **Köylü**, **Tılsım**, **Kafes** veya **Zemin** kutusuna yeni görselinizi sürükleyin veya seçin.
4. Oyun, görselin arka planını otomatik temizleyip tarayıcınızda anında uygular!

### Yöntem 2: Kalıcı Dosya Değişimi
`public/assets/sprites/` klasöründeki dosyaların üzerine kendi `256x256` şeffaf PNG dosyalarınızı kaydedebilirsiniz:
- `public/assets/sprites/werewolf.png`
- `public/assets/sprites/villager.png`
- `public/assets/sprites/totem.png`
- `public/assets/sprites/cage.png`
- `public/assets/sprites/ground_tile.png`

Eğer dış AI'dan düz renkli arka planlı (yeşil/beyaz) ham görseller aldıysanız, bunları `raw_assets/` içine koyup `python process_assets.py` komutunu çalıştırarak da otomatik şeffaf PNG üretebilirsiniz.
