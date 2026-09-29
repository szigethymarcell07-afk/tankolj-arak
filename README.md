# tankolj-arak

A **TankoljOkosan** iOS-app árai és töltői. A GitHub Actions 3 óránként letölti a friss árakat, naponta egyszer
a töltőket, és a GitHub Pages-en közzéteszi őket. Az app induláskor és előtérbe hozáskor innen tölti le az
adatokat, így a frissítésükhöz nem kell App Store-frissítés.

Közzétett fájlok:
- `https://szigethymarcell07-afk.github.io/tankolj-arak/prices.json`: árak, és egy rövid leírás a töltőlistáról
  (`chargers`: verzió, dátum, darabszám);
- `https://szigethymarcell07-afk.github.io/tankolj-arak/chargers.json`: a töltőlista. Az app csak akkor tölti le,
  ha a leírás szerint újabb, mint ami nála van.

## Mi történik egy futáskor (`.github/workflows/update-prices.yml`)

0. Csak a napi (02:40 UTC) és a kézi futásnál: `scripts/build-chargers.mjs` letölti a nyilvános töltőket az
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
4. `scripts/build-site.mjs` összeállítja a `_site/prices.json`-t és a `_site/chargers.json`-t, és a Pages
   közzéteszi őket.

A workflow kézzel is indítható (Actions → Árfrissítés → Run workflow), és minden `main`-re történő push is
újra közzéteszi az árakat.

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

A `src/data/chargers.json`-t itt a workflow frissíti; az appba beépítettet időnként (`npm run chargers` az
appban) érdemes frissíteni, de ez nem kötelező.

Az árak a kutak azonosítóihoz (`osm-…`) tartoznak, ezért itt ugyanannak a kútlistának kell lennie, mint az
appban. Ezt a `prices.json` `stationsGeneratedAt` mezője mutatja.

## Helyi próba

```bash
npm run prices   # árak letöltése
npm run site     # _site/prices.json összeállítása
```
