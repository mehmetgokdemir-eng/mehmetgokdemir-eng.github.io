#!/usr/bin/env node
/**
 * Kahve Sırları — merkezi içerik üretici.
 *
 * Günde bir kez çalışır ve şunları üretip "kahvefali/" klasörüne JSON yazar:
 *   1) Günlük burç yorumu   -> kahvefali/burc/<dil>/<burc>.json      (her gün yenilenir)
 *   2) Burç rehberi         -> kahvefali/rehber/<dil>/<burc>.json    (bir kez, kalıcı)
 *   3) Burç uyumu           -> kahvefali/uyum/<dil>/<a>__<b>.json    (bir kez, kalıcı)
 *
 * Günlük burç her çalışmada mutlaka üretilir. Kalan bütçe, eksik rehber ve
 * uyum metinlerini tamamlamak için kullanılır; böylece arşiv zamanla dolar.
 *
 * Ortam değişkenleri:
 *   GEMINI_API_KEY  (zorunlu)
 *   BACKLOG         (varsayılan 120)  bir çalışmada üretilecek arşiv metni sayısı
 *   MODEL           (varsayilan: gemini-3.1-flash-lite,gemini-2.5-flash,gemini-flash-latest)
 *                   virgulle ayrilmis model listesi; yanit vermeyen atlanir
 *   CIKTI           (varsayılan kahvefali)
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

// ─────────────────────────── Ayarlar ───────────────────────────

const API_KEY = process.env.GEMINI_API_KEY;
/**
 * Model listesi, tercih sırasına göre virgülle ayrılır.
 * Bir model üst üste 503/404 verirse sıradakine geçilir ve çalışmanın
 * geri kalanında o model kullanılmaya devam eder.
 */
const MODELS = (process.env.MODEL ||
  'gemini-3.5-flash-lite,gemini-3.5-flash,gemini-3.8-flash')
  .split(',').map(s => s.trim()).filter(Boolean);
const BACKLOG = Number(process.env.BACKLOG || 120);
const OUT     = process.env.CIKTI || 'kahvefali';
/** İki çağrı arası bekleme (ms). Dakikalık istek limitine takılmamak için. */
const GECIKME = Number(process.env.GECIKME || 1200);

if (!API_KEY) {
  console.error('HATA: GEMINI_API_KEY tanimli degil.');
  process.exit(1);
}

/** Uygulamadaki Zodiacs.all ile birebir aynı sıra ve id'ler. */
const ZODIACS = [
  { id: 'aries',       tr: 'Koç' },
  { id: 'taurus',      tr: 'Boğa' },
  { id: 'gemini',      tr: 'İkizler' },
  { id: 'cancer',      tr: 'Yengeç' },
  { id: 'leo',         tr: 'Aslan' },
  { id: 'virgo',       tr: 'Başak' },
  { id: 'libra',       tr: 'Terazi' },
  { id: 'scorpio',     tr: 'Akrep' },
  { id: 'sagittarius', tr: 'Yay' },
  { id: 'capricorn',   tr: 'Oğlak' },
  { id: 'aquarius',    tr: 'Kova' },
  { id: 'pisces',      tr: 'Balık' },
];

/** Uygulamanın desteklediği 12 dil. */
const LANGS = ['tr', 'en', 'de', 'es', 'fr', 'ru', 'pt', 'ar', 'fa', 'hi', 'id', 'zh'];

/**
 * Burç rehberi TR, EN, DE, ES, FR dillerinde uygulamanın içinde hazır.
 * Bu diller için uzak metin üretmeye gerek yok.
 */
const REHBER_LANGS = LANGS.filter(l => !['tr', 'en', 'de', 'es', 'fr'].includes(l));

/** Uygulamadaki langInstruction ile birebir aynı. */
const LANG_INSTRUCTION = {
  en: 'Respond in English.',
  de: 'Antworte auf Deutsch.',
  es: 'Responde en español.',
  fr: 'Réponds en français.',
  ru: 'Отвечай на русском языке.',
  pt: 'Responde em português.',
  ar: 'أجب باللغة العربية.',
  fa: 'به زبان فارسی پاسخ بده.',
  hi: 'उत्तर हिंदी में दें।',
  id: 'Jawab dalam bahasa Indonesia.',
  zh: '請用繁體中文回答。',
  tr: 'Yanıtı Türkçe ver.',
};

const SON_NOKTALAMA = ['.', '!', '?', '…', '"', ')', '。', '۔', '।'];

// ─────────────────────────── Yardımcılar ───────────────────────────

const bugun = () => new Date().toISOString().slice(0, 10);

const bekle = ms => new Promise(r => setTimeout(r, ms));

async function jsonOku(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return null; }
}

async function jsonYaz(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 1) + '\n', 'utf8');
}

/**
 * Uygulamadaki TextClean.stripMarkdown'un karşılığı:
 * modelin araya serpiştirdiği markdown işaretlerini temizler.
 */
function markdownTemizle(s) {
  return s
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/`{1,3}/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Son başarılı modelin MODELS listesindeki sırası — önce o denenir. */
let aktifModel = 0;

/** Bu çalışmada 404/403 veren modeller: kalıcı olarak atlanır. */
const oluModeller = new Set();

/** Denenecek model sıraları: önce son başarılı olan, sonra kalanlar; ölüler atlanır. */
function modelSirasi() {
  const sira = [];
  for (let i = aktifModel; i < MODELS.length; i++) sira.push(i);
  for (let i = 0; i < aktifModel; i++) sira.push(i);
  return sira.filter(i => !oluModeller.has(MODELS[i]));
}

/**
 * Gemini çağrısı.
 *
 * Geçici hatalarda (429 limit, 503 yoğunluk) artan beklemeyle üç kez dener,
 * olmazsa sıradaki modele geçer. 404/403 veren model çalışma boyunca ölü
 * sayılır ve bir daha denenmez; 503 ile pas geçilen modele ise sonraki
 * metinde yeniden şans verilir (yoğunluk geçici olabilir).
 */
async function gemini(systemPrompt, userText, maxOutputTokens) {
  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: {
      maxOutputTokens,
      thinkingConfig: { thinkingLevel: 'low' },
    },
  };

  let sonHata = 'bilinmiyor';
  const sira = modelSirasi();
  if (sira.length === 0) throw new Error('Kullanilabilir model kalmadi (hepsi 404/403 verdi)');

  for (const mi of sira) {
    const model = MODELS[mi];
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    let bekleme = 5000;
    for (let deneme = 1; deneme <= 3; deneme++) {
      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': API_KEY },
          body: JSON.stringify(body),
        });
      } catch (e) {
        sonHata = `ag hatasi: ${e.message}`;
        console.warn(`  ${model}: ${sonHata} (${deneme}/3)`);
        await bekle(bekleme); bekleme *= 2; continue;
      }

      // Geçici hata: bekleyip aynı modelle tekrar dene
      if (res.status === 429 || res.status >= 500) {
        const govde = (await res.text()).replace(/\s+/g, ' ').slice(0, 200);
        sonHata = `HTTP ${res.status}: ${govde}`;
        console.warn(
          `  ${model}: HTTP ${res.status} — ${bekleme / 1000}sn bekleniyor (${deneme}/3)`
        );
        if (deneme === 1 && govde) console.warn(`    yanit: ${govde}`);
        await bekle(bekleme); bekleme *= 2; continue;
      }

      // Model yok / erişim yok: çalışma boyunca ölü işaretle, sıradakine geç
      if (res.status === 404 || res.status === 403) {
        const govde = (await res.text()).replace(/\s+/g, ' ').slice(0, 200);
        sonHata = `HTTP ${res.status}: ${govde}`;
        oluModeller.add(model);
        console.warn(`  ${model}: HTTP ${res.status} — model olu, bir daha denenmeyecek`);
        if (govde) console.warn(`    yanit: ${govde}`);
        break;
      }

      // Kalıcı hata (400 gibi): model değiştirmek işe yaramaz
      if (!res.ok) {
        const govde = (await res.text()).replace(/\s+/g, ' ').slice(0, 300);
        throw new Error(`HTTP ${res.status}: ${govde}`);
      }

      const json = await res.json();
      const aday = json.candidates?.[0];
      const text = (aday?.content?.parts || [])
        .map(p => p.text).filter(Boolean).join('\n').trim();
      if (!text) throw new Error('Bos yanit geldi');

      if (mi !== aktifModel) {
        console.log(`  >> Aktif model: ${model}`);
        aktifModel = mi;
      }
      return { text: markdownTemizle(text), finishReason: aday?.finishReason || '' };
    }
  }

  throw new Error(`Hicbir model yanit vermedi (son hata: ${sonHata})`);
}

/**
 * Metin tamamlanmış mı?
 *
 * Asıl ölçüt API'nin finishReason alanı: "MAX_TOKENS" gelirse yanıt
 * token sınırına takılıp kesilmiş demektir. "STOP" ise model cümlesini
 * bitirmiştir. Noktalama kontrolü yalnızca finishReason gelmediğinde
 * yedek olarak kullanılır — son bölüm "uyumlu burç: Aslan" gibi harfle
 * bitebildiği için tek başına güvenilir değil.
 */
function tamMi(text, minUzunluk, finishReason) {
  if (text.length < minUzunluk) return false;
  if (finishReason === 'MAX_TOKENS') return false;
  if (finishReason) return true;
  return SON_NOKTALAMA.includes(text.trimEnd().slice(-1));
}

// ─────────────────────────── İstemler (uygulamayla birebir) ───────────────────────────

function burcPrompt(lang) {
  return 'Sen deneyimli bir astrologsun. ' +
    'Verilen burç için BUGÜNE özel, kapsamlı ve umut verici bir günlük yorum yaz. ' +
    'Yorumu şu başlıklar altında, her başlık için ayrı paragrafla yaz:\n' +
    'GÜNÜN GENEL ENERJİSİ — günün genel havası, öne çıkan tema, ruh hâli.\n' +
    'AŞK VE İLİŞKİLER — ilişkisi olanlar ve bekârlar için ayrı ayrı birkaç cümle.\n' +
    'İŞ VE KARİYER — iş yerinde bugün dikkat edilmesi gerekenler, fırsatlar.\n' +
    'PARA VE BEREKET — maddi konular, harcama ve kazanç eğilimi.\n' +
    'SAĞLIK VE ENERJİ — bedensel ve zihinsel durum, öneriler.\n' +
    'İLETİŞİM VE ÇEVRE — aile, arkadaşlar ve sosyal ortam.\n' +
    'GÜNÜN TAVSİYESİ — kısa, akılda kalıcı bir öneri.\n' +
    'GÜNÜN DETAYLARI — şanslı sayı, şanslı renk ve uyumlu burç.\n' +
    'Başlıkları büyük harfle yaz, altına açıklamayı ekle. ' +
    'Her bölüm en az 3-4 cümle olsun; yüzeysel geçme, somut ve akıcı yaz. ' +
    'Mistik ama samimi, sıcak bir dil kullan; okuyanı iyi hissettir. ' +
    'Toplam 500-700 kelime olsun. ' +
    'ÇOK ÖNEMLİ: Yukarıdaki bölüm başlıkları sana Türkçe verildi. ' +
    'Bu başlıkları AYNEN kopyalama; hedef dile çevirerek yaz. ' +
    'Yanıtın tamamı — başlıklar dahil — hedef dilde olmalı; ' +
    'tek bir Türkçe kelime bile bulunmamalı. ' +
    (LANG_INSTRUCTION[lang] || LANG_INSTRUCTION.tr);
}

function rehberPrompt(lang) {
  return 'Sen deneyimli bir astrologsun. Verilen burcun kapsamlı bir rehber ' +
    'metnini yaz. Metni şu başlıklar altında, her başlık için ayrı ' +
    'paragrafla yaz:\n' +
    'GENEL KARAKTER — burcun özü, elementi, yönetici gezegeni ve nitelikleri.\n' +
    'AŞK VE İLİŞKİLER — nasıl sever, nasıl bağlanır, ne bekler.\n' +
    'İŞ VE KARİYER — uygun meslekler, çalışma tarzı, güçlü olduğu alanlar.\n' +
    'PARA — kazanma ve harcama eğilimi.\n' +
    'ARKADAŞLIK VE AİLE — yakın ilişkilerdeki tavrı.\n' +
    'GÜÇLÜ YÖNLERİ — öne çıkan olumlu özellikler.\n' +
    'DİKKAT ETMESİ GEREKENLER — zorlandığı yanlar, yapıcı biçimde.\n' +
    'ÜÇ DEKAN — burcun kendi içindeki üç dönemi, tarihleriyle ve ' +
    'her dönemin farkıyla.\n' +
    'STRES ALTINDA — zorlandığında nasıl davranır, ne iyi gelir.\n' +
    'SAĞLIK EĞİLİMİ — burcun yönettiği beden bölgesi ve dikkat edilecekler.\n' +
    'ÖĞRENME VE İLETİŞİM TARZI — nasıl öğrenir, nasıl konuşur.\n' +
    'EV VE YAŞAM ALANI — yaşadığı mekânı nasıl kurar.\n' +
    'HEDİYE ÖNERİSİ — bu burca ne alınır.\n' +
    'RUHSAL DERSİ — hayat boyu öğrenmesi gereken şey.\n' +
    'UYUMLU OLDUĞU BURÇLAR — hangi burçlarla nasıl geçinir.\n' +
    'Başlıkları büyük harfle yaz, altına açıklamayı ekle. ' +
    'Her bölüm en az 3-4 cümle olsun; yüzeysel geçme. ' +
    'Sıcak, samimi ve olumlu bir dil kullan. ' +
    'Toplam 900-1200 kelime olsun. ' +
    'ÇOK ÖNEMLİ: Yukarıdaki bölüm başlıkları sana Türkçe verildi. ' +
    'Bu başlıkları AYNEN kopyalama; hedef dile çevirerek yaz. ' +
    'Yanıtın tamamı — başlıklar dahil — hedef dilde olmalı; ' +
    'tek bir Türkçe kelime bile bulunmamalı. ' +
    (LANG_INSTRUCTION[lang] || LANG_INSTRUCTION.tr);
}

function uyumPrompt(lang) {
  return 'Sen deneyimli bir ilişki astroloğusun. ' +
    'Verilen iki kişi arasındaki astrolojik uyumu kapsamlı biçimde yorumla. ' +
    'Yorumu şu başlıklar altında, her başlık için ayrı paragrafla yaz:\n' +
    'UYUM PUANI — 100 üzerinden bir puan ver ve tek cümleyle gerekçelendir.\n' +
    'GENEL UYUM — iki burcun elementleri ve nitelikleri nasıl etkileşiyor.\n' +
    'İLK TANIŞMA — birbirlerinde ilk neyi fark ederler, çekim nereden doğar.\n' +
    'GÜÇLÜ YANLARI — bu ilişkiyi ayakta tutan, birbirini besleyen yönler.\n' +
    'ANLAŞAMADIKLARI KONULAR — en sık çatıştıkları somut konular. ' +
    'Bu bölüm en ayrıntılı bölüm olsun; para, ev düzeni, sosyal hayat, ' +
    'kıskançlık, karar alma, aile ilişkileri gibi günlük hayattan örnekler ver.\n' +
    'İLETİŞİM — nasıl konuşurlar, tartışma anında ne olur, ne işe yarar.\n' +
    'DUYGUSAL YAKINLIK — sevgiyi ifade biçimleri örtüşüyor mu.\n' +
    'UZUN VADE — birlikte yaşam, ortak hedefler, zamanla ne değişir.\n' +
    'HER İKİSİNE TAVSİYE — iki tarafa ayrı ayrı birer öneri.\n' +
    'Başlıkları büyük harfle yaz, altına açıklamayı ekle. ' +
    'Her bölüm en az 3-4 cümle olsun; yüzeysel geçme. ' +
    'Dengeli ol: zor yanları dürüstçe söyle ama umutsuz bir tablo çizme, ' +
    'her çiftin işleyebileceğini ve neyin çaba gerektirdiğini belirt. ' +
    'Sıcak ve samimi bir dil kullan. Toplam 700-900 kelime olsun. ' +
    'ÇOK ÖNEMLİ: Yukarıdaki bölüm başlıkları sana Türkçe verildi. ' +
    'Bu başlıkları AYNEN kopyalama; hedef dile çevirerek yaz. ' +
    'Yanıtın tamamı — başlıklar dahil — hedef dilde olmalı; ' +
    'tek bir Türkçe kelime bile bulunmamalı. ' +
    (LANG_INSTRUCTION[lang] || LANG_INSTRUCTION.tr);
}

// ─────────────────────────── Görev listeleri ───────────────────────────

/** 12 burç × 2 cinsiyet = 24 kişi tipi; sırasız çiftler = 300 kombinasyon. */
function uyumCiftleri() {
  const kisiler = [];
  for (const z of ZODIACS) for (const c of ['F', 'M']) kisiler.push(`${z.id}-${c}`);
  kisiler.sort();

  const ciftler = [];
  for (let i = 0; i < kisiler.length; i++) {
    for (let j = i; j < kisiler.length; j++) {
      ciftler.push([kisiler[i], kisiler[j]]);
    }
  }
  return ciftler;
}

function kisiEtiketi(token) {
  const [id, c] = token.split('-');
  const z = ZODIACS.find(x => x.id === id);
  return c === 'F' ? `${z.tr} burcu kadını` : `${z.tr} burcu erkeği`;
}

// ─────────────────────────── Ana akış ───────────────────────────

const gun = bugun();
let uretilen = 0, atlanan = 0, hatali = 0;

/**
 * Üst üste bu kadar metin başarısız olursa çalışma erken ve DÜZGÜN bitirilir:
 * o ana kadar üretilenler yine yayınlanır, saatlerce boşa dönülmez.
 * (Örn. tüm modeller aynı anda yoğunsa ertesi çalışmada kaldığı yerden sürer.)
 */
const PES_PESE_SINIR = 10;
let pesPeseHata = 0;
let durdur = false;

async function uret(etiket, dosya, systemPrompt, userText, maxTokens, minUzunluk, ekAlanlar) {
  if (durdur) return false;
  try {
    const { text, finishReason } = await gemini(systemPrompt, userText, maxTokens);
    if (!tamMi(text, minUzunluk, finishReason)) {
      console.warn(
        `  ! ${etiket} kesik gorunuyor (${text.length} karakter, ${finishReason || 'finishReason yok'}), yazilmadi`
      );
      hatali++;
      basarisizSay();
      return false;
    }
    await jsonYaz(dosya, { ...ekAlanlar, text });
    uretilen++;
    pesPeseHata = 0;
    console.log(`  + ${etiket} (${text.length} karakter)`);
    return true;
  } catch (e) {
    console.warn(`  ! ${etiket} HATA: ${e.message}`);
    hatali++;
    basarisizSay();
    return false;
  }
}

function basarisizSay() {
  pesPeseHata++;
  if (pesPeseHata >= PES_PESE_SINIR && !durdur) {
    durdur = true;
    console.warn(
      `\n!! Ust uste ${PES_PESE_SINIR} metin basarisiz oldu — calisma erken bitiriliyor. ` +
      `O ana kadar uretilenler yayinlanacak; eksikler sonraki calismada tamamlanir.`
    );
  }
}

// ── 1) Günlük burç yorumları (her gün, hepsi) ──
console.log(`\n=== Gunluk burc yorumlari (${gun}) ===`);
for (const lang of LANGS) {
  if (durdur) break;
  const sp = burcPrompt(lang);
  for (const z of ZODIACS) {
    if (durdur) break;
    const dosya = join(OUT, 'burc', lang, `${z.id}.json`);
    const mevcut = await jsonOku(dosya);
    if (mevcut?.date === gun && mevcut?.text) { atlanan++; continue; }

    const tarih = new Date().toLocaleDateString('tr-TR', {
      day: 'numeric', month: 'long', year: 'numeric',
    });
    await uret(
      `burc/${lang}/${z.id}`, dosya, sp,
      `${z.tr} burcu için ${tarih} tarihli ayrıntılı günlük yorum.`,
      4000, 60, { date: gun, lang, zodiac: z.id },
    );
    await bekle(GECIKME);
  }
}

// ── 2) Eksik burç rehberi metinleri (kalıcı) ──
let butce = BACKLOG;
console.log(`\n=== Burc rehberi (eksikler, butce ${butce}) ===`);
for (const lang of REHBER_LANGS) {
  if (butce <= 0 || durdur) break;
  const sp = rehberPrompt(lang);
  for (const z of ZODIACS) {
    if (butce <= 0 || durdur) break;
    const dosya = join(OUT, 'rehber', lang, `${z.id}.json`);
    if (await jsonOku(dosya)) { atlanan++; continue; }

    const ok = await uret(
      `rehber/${lang}/${z.id}`, dosya, sp,
      `${z.tr} burcu rehberi.`,
      7000, 300, { lang, zodiac: z.id, updated: gun },
    );
    if (ok) butce--;
    await bekle(GECIKME);
  }
}

// ── 3) Eksik burç uyumu metinleri (kalıcı) ──
console.log(`\n=== Burc uyumu (eksikler, kalan butce ${butce}) ===`);
const ciftler = uyumCiftleri();
for (const lang of LANGS) {
  if (butce <= 0 || durdur) break;
  const sp = uyumPrompt(lang);
  for (const [a, b] of ciftler) {
    if (butce <= 0 || durdur) break;
    const ad = `${a}__${b}`;
    const dosya = join(OUT, 'uyum', lang, `${ad}.json`);
    if (await jsonOku(dosya)) { atlanan++; continue; }

    const ok = await uret(
      `uyum/${lang}/${ad}`, dosya, sp,
      `${kisiEtiketi(a)} ile ${kisiEtiketi(b)} uyumu.`,
      6000, 200, { lang, pair: ad, updated: gun },
    );
    if (ok) butce--;
    await bekle(GECIKME);
  }
}

// ── Özet ──
await jsonYaz(join(OUT, 'surum.json'), {
  updated: new Date().toISOString(),
  date: gun,
  model: MODELS[aktifModel],
});

console.log(`\n=== OZET ===`);
console.log(`Uretilen : ${uretilen}`);
console.log(`Atlanan  : ${atlanan} (zaten vardi)`);
console.log(`Hatali   : ${hatali}`);
console.log(`Kalan arsiv butcesi: ${butce}`);
