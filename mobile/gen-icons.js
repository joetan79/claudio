const sharp = require('sharp');
const path = require('path');

const SVG = path.join(__dirname, '../public/icon.svg');
const RES = path.join(__dirname, 'android/app/src/main/res');

// [density, launcher/round size, foreground canvas size]
const DENSITIES = [
  ['mdpi', 48, 108],
  ['hdpi', 72, 162],
  ['xhdpi', 96, 216],
  ['xxhdpi', 144, 324],
  ['xxxhdpi', 192, 432],
];

async function run() {
  for (const [density, size, fgSize] of DENSITIES) {
    const dir = path.join(RES, `mipmap-${density}`);

    await sharp(SVG).resize(size, size).png()
      .toFile(path.join(dir, 'ic_launcher.png'));

    await sharp(SVG).resize(size, size).png()
      .toFile(path.join(dir, 'ic_launcher_round.png'));

    // Foreground: logo scaled to ~72% of canvas, centered, transparent padding
    // (adaptive icon safe zone)
    const logoSize = Math.round(fgSize * 0.72);
    const logoBuf = await sharp(SVG).resize(logoSize, logoSize).png().toBuffer();
    await sharp({
      create: {
        width: fgSize, height: fgSize,
        channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([{ input: logoBuf, gravity: 'center' }])
      .png()
      .toFile(path.join(dir, 'ic_launcher_foreground.png'));

    console.log(`${density}: done`);
  }
}

run().catch(e => { console.error(e); process.exit(1); });
