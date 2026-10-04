# tankolj-arak

A **TankoljOkosan** iOS-app árai, töltői és töltési díjai. A GitHub Actions óránként letölti a friss árakat,
naponta egyszer a töltőket, és a GitHub Pages-en közzéteszi őket. Az óránkénti futást az app árbejelentő szervere
(Cloudflare Worker) indítja `workflow_dispatch`-csel (`kind: prices`, töltők nélkül), mert a GitHub saját időzítése
megbízhatatlan (napi 3–4 futás 8 helyett); a 3 óránkénti GitHub-időzítés tartaléknak maradt. A töltési díjakat itt kézzel kell frissíteni. Az
app induláskor és előtérbe hozáskor innen tölti le az adatokat, így a frissítésükhöz nem kell App Store-frissítés.

Közzétett fájlok:
- `https://szigethymarcell07-afk.github.io/tankolj-arak/prices.json`: az árak, a töltési díjak (`evTariffs`) és
  egy rövid leírás a töltőlistáról (`chargers`: verzió, dátum, darabszám);
- `https://szigethymarcell07-afk.github.io/tankolj-arak/chargers.json`: a töltőlista. Az app csak akkor tölti le,
  ha a leírás szerint újabb, mint ami nála van.

## Mi történik egy futáskor (`.github/workflows/update-prices.yml`)

0. Csak a napi (02:40 UTC) és a kézi futásnál (az Actions fülről; a `kind: prices` indítás kihagyja): `scripts/build-chargers.mjs` letölti a nyilvános töltőket az
   OpenStreetMap-ből (Overpass) → `src/data/chargers.json`. A városnevekhez a `scripts/.cache/places.json`
   kell. A 7 napnál régebbi adatot és a 20%-nál nagyobb visszaesést elutasítja. Ha nem sikerül, a régi lista
   marad, és a futás folytatódik.
1. `scripts/update-prices.mjs --soft`: letölti az országos átlagárat (Európai Bizottság Weekly Oil Bulletin
   + EKB-árfolyam), ha a meglévő 6 óránál régebbi → `src/data/priceReference.json`.
2. `scripts/update-station-prices.mjs`: letölti a kútonkénti árakat a benzinkutarak.hu-ról, és párosítja őket
   a `src/data/stations.json` kútjaival → `src/data/stationPrices.json`. Ha a forrás nem érhető el, a lépés
   hibát jelez, a régi árak maradnak, a többi lépés (mentés, közzététel) lefut.
3. Ha változott valami, commitolja az ár- és töltőfájlokat. Ezek a commitok egyben életben tartják az ütemezést: a GitHub
   60 nap aktivitás nélkül kikapcsolja az ütemezett workflow-kat.
4. `scripts/build-site.mjs` összeállítja a `_site/prices.json`-t (benne a `src/data/evTariffs.json` díjaival) és a
   `_site/chargers.json`-t, és a Pages közzéteszi őket.

A workflow kézzel is indítható (Actions → Árfrissítés → Run workflow), és minden `main`-re történő push is
újra közzéteszi az adatokat. Push után a kútárak letöltése `--soft` módban fut: ha a forrás épp nem válaszol, a
futás nem bukik el, a korábbi árak maradnak, és a következő óránkénti futás pótolja.

A többi futás (`--grace`) átmeneti kapcsolódási hibánál háromszor újrapróbál (20 s, 1 perc, 3 perc után). Ha a forrás
utána sem válaszol, de a legutóbbi sikeres ellenőrzés 6 óránál frissebb, a futás csak figyelmeztet (sárga jelzés az
Actions oldalon, e-mail nélkül), és a korábbi árak maradnak. Ha 6 óránál régebbi, vagy a hiba nem átmeneti
(például megváltozott a forrás oldalának felépítése), a futás elbukik, és jön az értesítő.

## Töltési díjak frissítése (`src/data/evTariffs.json`)

Ha egy töltőhálózat árat változtat, ebben a fájlban kell átírni, és pusholni. A push után pár percen belül
kint van, az app a következő megnyitáskor átveszi. Az appban lévő példány csak tartalék.

```bash
# a díjak átírása után:
npm run site     # ellenőrzi a fájlt; hibánál kiírja, melyik hálózatnál és sávnál van a gond
git add src/data/evTariffs.json && git commit -m "Töltési díjak frissítése" && git push
```

A fájl felépítése:
- `checked`: az ellenőrzés napja (`"2026-09-27"`), az app a forrásnál kiírja. Új ellenőrzésnél írd át.
- `networks`: hálózatonként `abbr`, `color`, `textColor` (a jelvény), `bands` (díjsávok), `note`, és ha kell,
  `memberNote`, `nightNote`, `source` (`label`, `url`).
- Egy sáv: `dc` (`true` = DC, `false` = AC), `upToKw` (eddig a teljesítményig érvényes; `null` = nincs felső
  határ), és legalább egy ár Ft/kWh-ban: `adhoc` (eseti, bankkártya/QR), `app` (applikációval), `member`
  (tagsággal), `night` (éjszakai). Helyszínenként eltérő árnál `[min, max]`. Az app az első illeszkedő sávot
  használja, ezért a sávok teljesítmény szerint növekvő sorrendben legyenek.
- Az `"Egyéb töltő"` hálózatnak mindig benne kell lennie (az ismeretlen hálózatok ezt kapják).

Hibás fájlnál a `build-site.mjs` kihagyja a díjakat a `prices.json`-ból (az appban a korábbi díjak maradnak), az
árak közzététele folytatódik, de a futás pirosan jelez az Actions fülön.

A hálózatnevek a `scripts/build-chargers.mjs` `NETWORK_RULES` listájából jönnek. Új hálózatnál oda is fel kell
venni (az app repójában is), különben a töltői „Egyéb töltő”-ként jelennek meg.

## Kapcsolat az app repójával

Az ár- és töltőletöltő szkriptek, a `src/data/stations.json` és a `scripts/.cache/places.json` **az app
repójából másolt** fájlok. Ha ott változnak (például az `npm run stations` új kútlistát készít), másold át őket
ide, és pushold:

```bash
cp ../benzinkút/scripts/update-prices.mjs ../benzinkút/scripts/update-station-prices.mjs ../benzinkút/scripts/build-chargers.mjs scripts/
cp ../benzinkút/src/data/stations.json src/data/
cp ../benzinkút/scripts/.cache/places.json scripts/.cache/
git add -A && git commit -m "Kútlista / szkriptek frissítése az appból" && git push
```

A töltési díjaknál fordított az irány: az `src/data/evTariffs.json` fő példánya itt van. Az appba beépítettet
időnként érdemes frissíteni (az app repójában: `cp ../tankolj-arak/src/data/evTariffs.json src/data/`), de ez nem
kötelező.

A `src/data/chargers.json`-t itt a workflow frissíti; az appba beépítettet időnként (`npm run chargers` az
appban) érdemes frissíteni, de ez nem kötelező.

Az árak a kutak azonosítóihoz (`osm-…`) tartoznak, ezért itt ugyanannak a kútlistának kell lennie, mint az
appban. Ezt a `prices.json` `stationsGeneratedAt` mezője mutatja.

## Helyi próba

```bash
npm run prices   # árak letöltése
npm run site     # _site/prices.json összeállítása
```
