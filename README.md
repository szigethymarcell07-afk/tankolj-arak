# tankolj-arak

A **TankoljOkosan** iOS-app árai. A GitHub Actions 3 óránként letölti a friss árakat, és a GitHub Pages-en
közzéteszi őket. Az app induláskor és előtérbe hozáskor innen tölti le az árakat, így az árfrissítéshez nem
kell App Store-frissítés.

Közzétett fájl: `https://<felhasználónév>.github.io/tankolj-arak/prices.json`

## Mi történik egy futáskor (`.github/workflows/update-prices.yml`)

1. `scripts/update-prices.mjs --soft`: letölti az országos átlagárat (Európai Bizottság Weekly Oil Bulletin
   + EKB-árfolyam), ha a meglévő 6 óránál régebbi → `src/data/priceReference.json`.
2. `scripts/update-station-prices.mjs`: letölti a kútonkénti árakat a benzinkutarak.hu-ról, és párosítja őket
   a `src/data/stations.json` kútjaival → `src/data/stationPrices.json`. Ha a forrás nem érhető el, a futás
   hibával leáll, és a legutóbb közzétett árak maradnak.
3. Ha változott ár, commitolja a két fájlt. Ezek a commitok egyben életben tartják az ütemezést: a GitHub
   60 nap aktivitás nélkül kikapcsolja az ütemezett workflow-kat.
4. `scripts/build-site.mjs` összeállítja a `_site/prices.json`-t, és a Pages közzéteszi.

A workflow kézzel is indítható (Actions → Árfrissítés → Run workflow), és minden `main`-re történő push is
újra közzéteszi az árakat.

## Kapcsolat az app repójával

A két árletöltő szkript és a `src/data/stations.json` **az app repójából másolt** fájl. Ha ott változnak
(például `npm run stations` új kútlistát készít), másold át őket ide, és pushold:

```bash
cp ../benzinkút/scripts/update-prices.mjs ../benzinkút/scripts/update-station-prices.mjs scripts/
cp ../benzinkút/src/data/stations.json src/data/
git add -A && git commit -m "Kútlista / szkriptek frissítése az appból" && git push
```

Az árak a kutak azonosítóihoz (`osm-…`) tartoznak, ezért itt ugyanannak a kútlistának kell lennie, mint az
appban. Ezt a `prices.json` `stationsGeneratedAt` mezője mutatja.

## Helyi próba

```bash
npm run prices   # árak letöltése
npm run site     # _site/prices.json összeállítása
```
