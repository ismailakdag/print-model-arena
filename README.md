# Print Model Arena

Google Sheet’teki 3D baskı modellerini mobil uyumlu, oyun hissi veren bir arayüzde tek tek puanlamak için hazırlanmış statik + Vercel Functions uygulaması.

## Ne yapıyor?

- Sheet’ten canlı CSV okur.
- Maliyet, satış fiyatı, net kâr, marj, gram, tabla adedi ve baskı süresini aynı kartta gösterir.
- 410 model üzerinde arama, filtre ve sıralama sağlar.
- Mobilde tek kart + büyük iki karar butonu olarak çalışır.
- Masaüstünde kartın yanında oturum özeti, katalog istatistikleri ve son kararları gösterir.
- İki puanlama modu vardır:
  - **kişisel puanım:** ad/rumuz bazında oylar ayrı `Oylamalar` sekmesine satır olarak yazılır.
  - **ortak puanlama:** mevcut `Beğeni` hücresi doluysa model kilitlenir; yalnızca boş modeller oylanır.
- Vercel write proxy, Apps Script secret’ını tarayıcıya göndermez.
- Apps Script `LockService` ile aynı anda gelen oyların çakışmasını engeller.

## Veri kaynağı

Kaynak Sheet:

<https://docs.google.com/spreadsheets/d/1tJtASEdnz5HCUtkVqlTua-t2XoYGmHxL3FgJO7Y4UVI/edit>

Sheet’in **bağlantıya sahip herkes tarafından görüntülenebilir** olması gerekir. Frontend yalnızca CSV okur; Google OAuth token’ı frontend’e konulmaz.

## Vercel’e deploy

1. Bu klasörü GitHub’a push et.
2. Vercel’de **Import Git Repository** ile repo’yu seç.
3. Framework olarak **Other** veya boş bırak.
4. Build command boş, output directory `.` bırak.
5. Deploy sonrası Vercel Project Settings → Environment Variables içine şunları ekle:

```text
SHEET_WRITE_URL=https://script.google.com/macros/s/DEPLOYMENT_ID/exec
SHEET_WRITE_SECRET=yerel_olarak_urettigin_gizli_deger
```

`SHEET_WRITE_SECRET` GitHub’a, frontend koduna veya sohbet mesajına yazılmaz.

## Apps Script write endpoint kurulumu

1. Kaynak Sheet’i aç.
2. **Uzantılar → Apps Script** seç.
3. `apps-script/Code.gs` içeriğini yapıştır.
4. Apps Script’te **Project Settings → Script properties** bölümünden şu property’yi ekle:

```text
Name: WRITE_SECRET
Value: aynı_gizli_deger
```

5. **Deploy → New deployment → Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone**
6. `/exec` ile biten URL’yi Vercel’de `SHEET_WRITE_URL` olarak kullan.
7. Vercel env’deki `SHEET_WRITE_SECRET` değerini Apps Script property’siyle aynı yap.
8. Yeni deploy sonrası Vercel’de redeploy et.

İlk kişisel oy geldiğinde Apps Script Sheet içinde otomatik olarak `Oylamalar` sekmesini oluşturur:

```text
Zaman | Kullanıcı | Model ID | Oy | Model
```

## Güvenlik ve kimlik davranışı

- İsim/rumuz basit katılımcı kimliğidir; güçlü kimlik doğrulama değildir.
- Küçük kapalı ekip için yeterlidir.
- Herkese açık kullanımda sonraki aşamada Google login veya davet kodu eklenmelidir.
- Ortak modda mevcut `Beğeni` değerleri korunur ve dolu satırlar tekrar yazılmaz.
- Kişisel mod mevcut `Beğeni` sütununu değiştirmez.
- Apps Script write endpoint’i yalnız secret bilen Vercel proxy’den beklenen payload’ları kabul eder.

## Yerel test

Statik kısmı çalıştırmak için:

```bash
python3 -m http.server 4173
```

Sonra <http://localhost:4173> açılır. Write endpoint kurulmadıysa oylar yalnızca yerel önizleme olarak davranır ve arayüz bunu açıkça belirtir; başarılı Sheet yazması iddia etmez.

## Kabul kriterleri

- [x] Sheet’ten canlı veri okuma
- [x] Mobil/masaüstü responsive kart arayüzü
- [x] Ortak puanlama modu ve dolu hücre kilidi
- [x] Kişisel puanlama modu
- [x] Çoklu kullanıcı için satır bazlı `Oylamalar` şeması
- [x] Eşzamanlı yazma kilidi
- [x] Vercel proxy
- [ ] Apps Script URL ve secret’ın gerçek deploy ortamına bağlanması
- [ ] Google Login / davet kodu ile güçlü katılımcı kimliği
