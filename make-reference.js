const path = require('path');
const fs   = require('fs');
const docx = require(path.join(require('os').homedir(), 'AppData/Roaming/npm/node_modules/docx'));

const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  AlignmentType, HeadingLevel, BorderStyle, WidthType, ShadingType,
  PageOrientation,
} = docx;

// ── Layout constants ─────────────────────────────────────────────────────────
// Landscape US Letter: content width = 15840 - 2880 = 12960 DXA
const CONTENT_W = 12960;
const COL1 = 3000;  // action name
const COL2 = 1200;  // cost
const COL3 = 1500;  // season / winter
const COL4 = CONTENT_W - COL1 - COL2 - COL3; // 7260 — notes

const bdr = { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC' };
const borders = { top: bdr, bottom: bdr, left: bdr, right: bdr };
const cm = { top: 80, bottom: 80, left: 140, right: 140 };

const ROME_BG    = 'F5E8E8';
const CARTH_BG   = 'EDE0F5';
const HEADER_BG  = '2E2E2E';
const ROW_A      = 'FAFAFA';
const ROW_B      = 'F0F0F0';

function hCell(text, w, align) {
  return new TableCell({
    borders,
    width: { size: w, type: WidthType.DXA },
    shading: { fill: HEADER_BG, type: ShadingType.CLEAR },
    margins: cm,
    children: [new Paragraph({
      alignment: align || AlignmentType.LEFT,
      children: [new TextRun({ text, bold: true, size: 20, font: 'Arial', color: 'FFFFFF' })],
    })],
  });
}

function cell(text, w, shade, bold, color, align, italic) {
  return new TableCell({
    borders,
    width: { size: w, type: WidthType.DXA },
    shading: { fill: shade, type: ShadingType.CLEAR },
    margins: cm,
    children: [new Paragraph({
      alignment: align || AlignmentType.LEFT,
      children: [new TextRun({ text, bold: !!bold, size: 19, font: 'Arial',
        color: color || '222222', italics: !!italic })],
    })],
  });
}

function headerRow(cols) {
  return new TableRow({ tableHeader: true, children: cols.map(([t, w]) => hCell(t, w)) });
}

function dataRow(action, cost, when, notes, shade, sideColor) {
  const bg = sideColor || shade;
  return new TableRow({ children: [
    cell(action, COL1, bg, true),
    cell(cost,   COL2, bg, false, '8B0000', AlignmentType.CENTER),
    cell(when,   COL3, bg, false, '444444', AlignmentType.CENTER, true),
    cell(notes,  COL4, bg),
  ]});
}

function sectionRow(label, color) {
  return new TableRow({ children: [
    new TableCell({
      borders,
      columnSpan: 4,
      width: { size: CONTENT_W, type: WidthType.DXA },
      shading: { fill: color, type: ShadingType.CLEAR },
      margins: { top: 60, bottom: 60, left: 140, right: 140 },
      children: [new Paragraph({
        children: [new TextRun({ text: label, bold: true, size: 20, font: 'Arial', color: '333333' })],
      })],
    }),
  ]});
}

function spacerPara() {
  return new Paragraph({ children: [new TextRun({ text: '', size: 18 })] });
}

function title(text, sub) {
  return [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 0, after: 60 },
      children: [new TextRun({ text, bold: true, size: 48, font: 'Arial', color: '8B0000' })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 0, after: 320 },
      children: [new TextRun({ text: sub, size: 22, font: 'Arial', color: '666666', italics: true })],
    }),
  ];
}

function sectionHeading(text) {
  return new Paragraph({
    spacing: { before: 280, after: 80 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '8B0000', space: 4 } },
    children: [new TextRun({ text, bold: true, size: 28, font: 'Arial', color: '8B0000' })],
  });
}

// ── Initiative table ─────────────────────────────────────────────────────────
// when: S = Campaign Season, W = Winter
const IP_ROWS = [
  // [action, cost, when, notes, shade]
  ['Hold',                     '0 IP',  'Season', 'Army stays in place.',                                                                ROW_A],
  ['Move',                     '0 IP',  'Season', 'Move to any adjacent region.',                                                        ROW_B],
  ['Force battle',             '1 IP',  'Season', 'Declare Force during an encounter. Free after 2 consecutive mutual refusals.',         ROW_A],
  ['Scout',                    '1 IP',  'Season', 'Roll 4+ to reveal an enemy army\u2019s location. Can be fooled by a feint.',           ROW_B],
  ['Feint',                    '1 IP',  'Season', 'Plant a false position marker in an adjacent region. Lasts 1 turn.',                   ROW_A],
  ['Establish Depot',          '1 IP',  'Season', 'Place a supply depot. Also costs 1 Resource. Friendly-controlled region only.',        ROW_B],
  ['Siege',                    '1 IP',  'Season', 'Advance breach points on a fortified SP. Requires siege equipment (bought in winter).', ROW_A],
  ['Forced Sea Crossing',      '1 IP',  'Season', 'Attempt sea lane without naval control. Roll 1d6: 4+ succeeds (arrives out of supply); 1\u20133 fails (IP spent, army stays). Naval holder always informed.', ROW_B],
  ['Deep Scout',               '2 IP',  'Season', 'Always reveals exact location + condition. Pierces feints.',                          ROW_A],
  ['\u2295 Battle victory',    '+1 IP', 'Season', 'Earned immediately when a battle is won. Does not carry over at season end.',         ROW_B],
];

// ── Resource table ────────────────────────────────────────────────────────────
const RES_ROWS = [
  // [action, cost, when, notes, shade, sideColor]
  // Income sources
  ['INCOME', '', '', '', '', ''],
  ['Regions controlled',          '+1 / 3 regions', 'Winter', 'Scored at winter start. Rounded down.',                               ROW_A],
  ['Naval control',               '+1',              'Winter', 'Only if your side holds outright control (not contested).',           ROW_B],
  ['Battle victories (season)',   '+1 / battle',     'Winter', 'Each battle won this season adds +1 at winter income.',              ROW_A],
  ['Banking cap',                 'max 3',           'Winter', 'Unspent resources above 3 are lost at season end.',                   ROW_B],
  // Campaign season spending
  ['CAMPAIGN SEASON SPENDING', '', '', '', '', ''],
  ['Establish Depot',             '1 Res + 1 IP',    'Season', 'Creates a supply depot in a friendly-controlled region.',            ROW_A],
  ['Emergency Reinforce',         '2 Res',           'Season', '+10% points budget for one army this season. Once per season. Costs 3 Res if you are Carthage and Rome holds naval control.', ROW_B],
  // Winter spending
  ['WINTER SPENDING', '', '', '', '', ''],
  ['Naval bid',                   '0\u20132 Res',    'Winter', 'Both players bid secretly. Higher bid wins naval control. Tie = contested (both may use sea lanes).',  ROW_A],
  ['Reinforce army',              '1 Res',           'Winter', 'Recover one condition step on a damaged army. Can be done multiple times (each step costs 1).',         ROW_B],
  ['Buy siege equipment',         '1 Res',           'Winter', 'Equip one army for siege operations next season.',                                                       ROW_A],
  ['Mercenary contingent',        '1 Res (2 if opp. holds naval)', 'Winter \u2022 Carthage', 'Grant +10% pts to a Carthage army in Italia. Once per season.',          CARTH_BG],
  ['Allied contingent',           'Free',            'Winter \u2022 Both',  'Grant +10% pts to an army in Italia. Rome requires a loyal Italian ally region; Carthage requires a defected region. Once per season.', ROW_B],
  ['Raise new army',              '3 Res',           'Winter', 'Only available if your side has fewer than 2 armies. Spawns at home base as Levy / Good.',              ROW_A],
];

function buildIPTable() {
  return new Table({
    width: { size: CONTENT_W, type: WidthType.DXA },
    columnWidths: [COL1, COL2, COL3, COL4],
    rows: [
      headerRow([['Action', COL1], ['IP Cost', COL2], ['Phase', COL3], ['Notes', COL4]]),
      ...IP_ROWS.map(([a, c, w, n, s]) => dataRow(a, c, w, n, s)),
    ],
  });
}

function buildResTable() {
  const rows = [
    headerRow([['Action / Source', COL1], ['Amount', COL2], ['Phase', COL3], ['Notes', COL4]]),
  ];
  let inSection = false;
  RES_ROWS.forEach(([a, c, w, n, s, sc]) => {
    if (c === '' && w === '' && n === '') {
      // Section divider
      rows.push(sectionRow(a, 'E8E0D0'));
    } else {
      rows.push(dataRow(a, c, w, n, s, sc || null));
    }
  });
  return new Table({
    width: { size: CONTENT_W, type: WidthType.DXA },
    columnWidths: [COL1, COL2, COL3, COL4],
    rows,
  });
}

// ── Build document ────────────────────────────────────────────────────────────
const doc = new Document({
  styles: {
    default: { document: { run: { font: 'Arial', size: 20 } } },
  },
  sections: [{
    properties: {
      page: {
        size: { width: 12240, height: 15840, orientation: PageOrientation.LANDSCAPE },
        margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 },
      },
    },
    children: [
      ...title('BELLUM PUNICUM', 'Initiative & Resource Reference'),
      sectionHeading('Initiative Points  (4 per season \u2014 campaign season only)'),
      buildIPTable(),
      spacerPara(),
      sectionHeading('Resources'),
      buildResTable(),
      spacerPara(),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({
          text: 'Condition effect on points budget:  Good = 100%  \u2022  Worn = 95%  \u2022  Depleted = 90%  \u2022  Broken = 80%  \u2014  Emergency Reinforce counts as one step better for pts purposes.',
          size: 17, italics: true, color: '666666', font: 'Arial',
        })],
      }),
    ],
  }],
});

Packer.toBuffer(doc).then(buf => {
  fs.writeFileSync('Bellum_Punicum_Reference.docx', buf);
  console.log('Written: Bellum_Punicum_Reference.docx');
});
