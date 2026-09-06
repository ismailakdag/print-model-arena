# Print Model Arena

3D baskı modellerini Google Sheet’teki canlı CSV’den alıp mobil öncelikli, seri bir inceleme akışında puanlayan statik + Vercel Functions uygulaması.

## Akış

- Kartı mobilde sağa sürüklemek **beğendim**, sola sürüklemek **beğenmedim** demektir.
- Desktop’ta mouse drag, büyük butonlar ve `ArrowLeft` / `ArrowRight` aynı oyu verir.
- Oy görsel olarak anında uygulanır ve kart ağ isteğini beklemeden sıradaki modele geçer.
- **Geri al** (`↶ geri al` veya `Z`) yalnızca kişisel moddaki bu oturumun son kararında çalışır. Önceki oy yerelde anında geri gelir; gerekli update/undo işlemi kuyruğa alınır.
- Kişisel oy, ana veri sekmesinde `Oy · <katılımcı>` adlı kolona modelin sabit satırında yazılır. `Oylamalar` sekmesi eski istemciler ve raporlar için eşzamanlı mirror olarak korunur.
- Ortak mod canonical `Beğeni` hücresini yalnızca boşsa yazar ve dolu satırı kilitli tutar. Aynı oyla gelen ağ retry’ı idempotent başarı sayılır.
- Paylaşılan Sheet verisi frontend’de yalnızca CSV olarak okunur; frontend’e secret gönderilmez.

## Optimistic kayıt kuyruğu

- Her karar `localStorage` içindeki kalıcı kuyruğa, benzersiz `operationId` ile önce yazılır; `fetch` kart geçişini veya sonraki oyu bloklamaz.
- Aynı mod + katılımcı + model için henüz gönderilmemiş eski işlem son kararla değiştirilir. Gönderilmekte olan işlemin arkasına gelen undo/değişiklik sırasını korur.
- Geçici ağ/5xx/429 hataları 1 saniyeden başlayan üstel backoff ile en fazla altı kez denenir. Kalıcı veya tükenen hata cihazda silinmez ve **yeniden dene** kontrolünde görünür.
- Offline kararlar cihazda kalır ve `online` olayıyla yeniden gönderilir. Sayfa kapanırken kuyruk tekrar kalıcı depoya yazılır; reload sırasında bekleyen kararlar hem arayüze yeniden uygulanır hem gönderime devam eder.
- Kuyrukta gerçek Sheet yazısı yapan test yoktur; testler sahte bir gönderici ve bellek depolaması kullanır.

## Veri kaynağı ve görüntü bulguları

Kaynak Sheet:

<https://docs.google.com/spreadsheets/d/1tJtASEdnz5HCUtkVqlTua-t2XoYGmHxL3FgJO7Y4UVI/edit>

6 Eylül 2026 tarihinde salt-okunur CSV kontrolü:

- CSV HTTP 200, **410 model satırı**.
- `Görsel URL` dolu **388 satır**; tamamı `drive.google.com` hostunda.
- **22 satırda görsel URL’si yok**. Bu satırlar desteye girmeden filtrelenir; model, ilerleme ve özet sayılarına kesinlikle dahil edilmez.
- Temsilî Drive thumbnail istekleri HTTP 200 ve `image/png`/`image/jpeg` döndürdü. Bir URL tarayıcıda yine de yüklenemezse ilgili model desteden çıkarılır.
- Drive dosyalarının uygulama tarafından görülebilmesi için dosyada **Genel erişim → Bağlantıya sahip herkes → Görüntüleyici** gerekir. İzinleri aşan bir proxy veya kaynak site scraping’i yoktur.
- Uygulama yalnızca geçerli `http:`/`https:` görsel URL’si olan satırları normalize eder. Hiçbiri kalmazsa kaynak satır sayısını belirten dürüst boş durum gösterir. Tarayıcıda yüklenemeyen bir görsel de desteden ve sayılardan çıkarılır.

## Vercel deploy

1. Vercel’de bu GitHub reposunu import edin.
2. Framework **Other** veya boş, build command boş, output directory `.` bırakın.
3. Project Settings → **Environment Variables** bölümünde hedefi özellikle **Production** seçerek şu iki değişkeni ekleyin:

```text
SHEET_WRITE_URL=https://script.google.com/macros/s/DEPLOYMENT_ID/exec
SHEET_WRITE_SECRET=<Apps Script WRITE_SECRET ile aynı değer>
```

Secret’i GitHub’a, frontend’e veya issue/sohbet içine koymayın. Önceden eklenmiş Preview/Development env değerleri Production’a otomatik taşınmaz.

4. Değişkenleri kaydettikten sonra **Deployments → Redeploy → Production** ile yeni deployment oluşturun. Sadece env kaydetmek eski production deployment’ı değiştirmez.
5. Deploy edilen origin üzerinde şu status endpoint’ini açın:

```text
https://YOUR_VERCEL_DOMAIN/api/rate?status=1
```

Başarılı cevap secret içermez ve `config.endpointConfigured`, `config.secretConfigured`, `upstream.status: "ok"` alanlarını gösterir. Eksik env için `code: "proxy_not_configured"`; Apps Script’e ulaşılamıyorsa `code: "upstream_unreachable"` döner. Arayüz bu mesajı control panelde ve footer’da gösterir; artık tüm hatalar “not connected” olarak gizlenmez.

`package.json` Node `24.x` ister. `vercel.json` içinde geçersiz `functions.runtime` ayarı yoktur.

## Apps Script write endpoint kurulumu

1. Kaynak Sheet → **Uzantılar → Apps Script**.
2. `apps-script/Code.gs` içeriğini yapıştırın/kaydedin.
3. Project Settings → **Script properties** içine ekleyin:

```text
Name: WRITE_SECRET
Value: <uzun, rastgele ve yalnızca sizde bulunan değer>
```

4. **Deploy → New deployment → Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Deployment URL’sinin `/exec` ile bittiğini kontrol edin; `/dev` URL’sini Vercel’e vermeyin.
6. Kod değişince **Deploy → Manage deployments → Edit → New version → Deploy** yapın. Eski deployment’a yeni kod otomatik gitmez.
7. Vercel Production `SHEET_WRITE_URL` ve `SHEET_WRITE_SECRET` değerlerini güncelleyin; sonra Vercel Production’ı yeniden deploy edin.
8. Önce Vercel status endpoint’ini, sonra arayüzde gerçek kullanıcı olmayan bir akışla kontrol edin. Bu repo doğrulama sırasında gerçek Sheet’e test oyu yazmadı.

Apps Script sözleşmesi (v2; eski payload alanları geçerliliğini korur):

- `GET /exec?action=status&secret=…` → güvenli hazır cevabı.
- `GET /exec?action=list&participant=…&secret=…` → `{ ok: true, votes: { modelId: "like|dislike" } }`.
- `POST /exec` JSON oy payload’ı:

```json
{"mode":"personal","participant":"rumuz","id":"model-id","vote":"like","operationId":"uuid","contractVersion":2,"secret":"…"}
```

- Kişisel değişiklik ana sekmede `Oy · rumuz` kolonunun mevcut model satırını update eder; model satırları eklenmez, silinmez veya yeniden sıralanmaz. Aynı karar ayrıca `Oylamalar` içindeki `Zaman | Kullanıcı | Model ID | Oy | Model | İşlem ID` kaydına update/append edilir.
- Kişisel liste okuması önce named column’u, eksikler için eski `Oylamalar` satırlarını kullanır. Böylece eski veri geriye dönük okunabilir.
- Kişisel geri almada:

```json
{"action":"undo","mode":"personal","participant":"rumuz","id":"model-id","secret":"…"}
```

- Shared payload’ı yalnızca `Beğeni` boşsa yazar; aynı değerli retry başarı döner. Tüm shared/personal okuma-yazmalar `LockService.getScriptLock()` ile korunur.

## Yazma endpoint’i neden önce yanıltıcıydı?

Eski frontend hem participant listesindeki GET hatasını hem de POST hatasını tek bir `catch` içinde `yerel önizleme` durumuna indiriyordu. Vercel function da upstream hata ayrıntısını `Sheet write endpoint erişilemedi` ile kaybediyordu. Sonuçta eksik Production env, yanlış `/dev` URL’si, eski deployment veya Apps Script erişim izni aynı “bağlı değil” belirtisine dönüşüyordu.

Yeni proxy:

- config eksikliğini `proxy_not_configured` ile ayırır,
- Apps Script status probe sağlar,
- upstream erişilememe / geçersiz JSON / reddedilen istek için güvenli kod ve açıklama döndürür,
- host bilgisi dışında secret veya network exception ayrıntısı göstermez.

## Yerel geliştirme ve test

Statik UI:

```bash
python3 -m http.server 4173
```

Bu komut `/api/rate` function’ını sağlamaz. UI’daki diagnostic bu durumu JSON olmayan `/api/rate` cevabı olarak açıklar. Function probe için Vercel CLI ile env’leri yerel olarak sağlamak veya doğrudan deployed status endpoint’ini kullanmak gerekir; test oyunu göndermeyin.

Kontroller:

```bash
node --check app.js
node --check api/rate.js
python3 -m json.tool package.json
python3 -m json.tool vercel.json
npm test
```

Testler gerçek Sheet’e veya Apps Script’e yazmaz; proxy contract, status/config diagnostics, invalid JSON, operation ID, görsel satır filtreleme, optimistic kalıcı kuyruk, deduplication, retry/backoff, reload recovery ve Apps Script named-column/legacy/lock sözleşmesini kontrol eder.

## Güvenlik ve sınırlar

- `WRITE_SECRET` source control’a konmaz ve API cevaplarında dönmez.
- Katılımcı adı güçlü kimlik doğrulama değildir.
- Ortak modda dolu canonical oy değiştirilemez.
- Drive dosyaları public viewer değilse uygulama izinleri bypass etmez; yalnızca açıklayıcı no-image state gösterir.
