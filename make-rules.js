const path = require('path');
const fs   = require('fs');
const docx = require(path.join(require('os').homedir(), 'AppData/Roaming/npm/node_modules/docx'));

const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  AlignmentType, HeadingLevel, BorderStyle, WidthType, ShadingType,
  LevelFormat,
} = docx;

// ── Helpers ─────────────────────────────────────────────────────────────────

const CONTENT_W = 9360; // US Letter, 1" margins

function h1(text) {
  return new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(text)] });
}
function h2(text) {
  return new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(text)] });
}
function body(text) {
  return new Paragraph({ children: [new TextRun({ text, size: 22 })] });
}
function spacer() {
  return new Paragraph({ children: [new TextRun({ text: '', size: 22 })] });
}
function bullet(text, bold_prefix) {
  const children = bold_prefix
    ? [new TextRun({ text: bold_prefix, bold: true, size: 22 }),
       new TextRun({ text, size: 22 })]
    : [new TextRun({ text, size: 22 })];
  return new Paragraph({
    numbering: { reference: 'bullets', level: 0 },
    children,
  });
}
function note(text) {
  return new Paragraph({
    children: [new TextRun({ text, size: 20, italics: true, color: '555555' })],
    indent: { left: 360 },
  });
}

const border = { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC' };
const borders = { top: border, bottom: border, left: border, right: border };

function defRow(term, definition, shade) {
  return new TableRow({
    children: [
      new TableCell({
        borders,
        width: { size: 2000, type: WidthType.DXA },
        shading: shade ? { fill: 'EEE8D5', type: ShadingType.CLEAR } : { fill: 'FFFFFF', type: ShadingType.CLEAR },
        margins: { top: 80, bottom: 80, left: 120, right: 120 },
        children: [new Paragraph({ children: [new TextRun({ text: term, bold: true, size: 20 })] })],
      }),
      new TableCell({
        borders,
        width: { size: 7360, type: WidthType.DXA },
        shading: shade ? { fill: 'EEE8D5', type: ShadingType.CLEAR } : { fill: 'FFFFFF', type: ShadingType.CLEAR },
        margins: { top: 80, bottom: 80, left: 120, right: 120 },
        children: [new Paragraph({ children: [new TextRun({ text: definition, size: 20 })] })],
      }),
    ],
  });
}

function twoColTable(rows) {
  return new Table({
    width: { size: CONTENT_W, type: WidthType.DXA },
    columnWidths: [2000, 7360],
    rows: rows.map((r, i) => defRow(r[0], r[1], i % 2 === 0)),
  });
}

// ── Document ─────────────────────────────────────────────────────────────────

const doc = new Document({
  numbering: {
    config: [{
      reference: 'bullets',
      levels: [{ level: 0, format: LevelFormat.BULLET, text: '\u2022', alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 540, hanging: 270 } } } }],
    }],
  },
  styles: {
    default: { document: { run: { font: 'Georgia', size: 22 } } },
    paragraphStyles: [
      { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: 36, bold: true, font: 'Arial', color: '8B0000' },
        paragraph: { spacing: { before: 320, after: 160 }, outlineLevel: 0,
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '8B0000', space: 4 } } } },
      { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: 26, bold: true, font: 'Arial', color: '5C3317' },
        paragraph: { spacing: { before: 240, after: 100 }, outlineLevel: 1 } },
    ],
  },
  sections: [{
    properties: {
      page: {
        size: { width: 12240, height: 15840 },
        margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
      },
    },
    children: [

      // ── Title block ──────────────────────────────────────────────────────
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 0, after: 80 },
        children: [new TextRun({ text: 'BELLUM PUNICUM', bold: true, size: 56, font: 'Arial', color: '8B0000' })],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 0, after: 80 },
        children: [new TextRun({ text: '218\u2013214 BC  \u2014  Campaign Rules Overview', size: 26, font: 'Arial', color: '555555', italics: true })],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 0, after: 400 },
        children: [new TextRun({ text: 'Hannibal Barca commands Carthage. Rome defends the Republic.', size: 22, italics: true, color: '666666' })],
      }),

      // ── The Campaign ─────────────────────────────────────────────────────
      h1('The Campaign'),
      body('Bellum Punicum is a two-player strategic campaign covering the opening years of the Second Punic War. One player commands Carthage (and Hannibal); the other commands Rome. Individual battles are resolved in Field of Glory 2 (FoG2) and the results entered back into the campaign manager. Everything else \u2014 movement, supply, diplomacy, and resource management \u2014 is handled here.'),
      spacer(),
      body('The campaign runs for five years (218\u2013214 BC), each divided into eight turns of campaigning followed by a Winter Phase. Victory is determined by Victory Points accumulated at each winter.'),

      spacer(),

      // ── The Map ──────────────────────────────────────────────────────────
      h1('The Map'),
      body('The map covers the western Mediterranean and is divided into 20 regions grouped into six theaters:'),
      spacer(),
      twoColTable([
        ['Iberia',   'Hispania Ulterior, Hispania Citerior, Pyrenean Passes'],
        ['Gaul',     'Transalpine Gaul, Alpine Passes, Cisalpine Gaul'],
        ['Italia',   'Liguria, Etruria, Umbria/Picenum, Latium (Rome), Campania, Samnium/Lucania, Bruttium/Calabria, Venetia'],
        ['Islands',  'Sicily, Sardinia & Corsica'],
        ['Africa',   'Africa Proper (Carthage), Numidia West, Numidia East'],
        ['Balkans',  'Illyria'],
      ]),
      spacer(),
      body('Armies move between adjacent regions. Some regions are connected only by sea lanes (shown on the map); crossing a sea lane requires naval control or a risky forced crossing.'),

      spacer(),

      // ── Armies ───────────────────────────────────────────────────────────
      h1('Armies'),
      h2('Condition'),
      body('Every army has a condition rating representing its current fighting strength:'),
      spacer(),
      twoColTable([
        ['Good',      'Full strength \u2014 no penalties'],
        ['Worn',      'Reduced cohesion \u2014 still effective'],
        ['Depleted',  'Significantly degraded \u2014 vulnerable to further losses'],
        ['Broken',    'Near combat ineffective \u2014 destroyed if lost in battle or caught out of supply over winter'],
      ]),
      spacer(),
      body('Condition degrades from supply failure and battle losses, and recovers during Winter Quarters.'),

      spacer(),
      h2('Experience'),
      body('Armies also carry an experience rating: Levy \u2192 Seasoned \u2192 Veteran \u2192 Elite. Experience improves through decisive battle victories and time in the field, and affects the quality of the FoG2 list you can field.'),

      spacer(),
      h2('Points Budget'),
      body('Each army has a points budget for building its FoG2 army list. This base value is modified by:'),
      bullet(' Emergency reinforcement (+10%, once per season, costs 2 resources)', '\u2022 '),
      bullet(' Allied contingent for Rome (+10%)', '\u2022 '),
      bullet(' Mercenary contingent for Carthage (+10%)', '\u2022 '),
      bullet(' Secondary army support in the same region (+10% to primary army)', '\u2022 '),

      spacer(),

      // ── Turn Structure ───────────────────────────────────────────────────
      h1('Turn Structure'),
      body('Each campaign turn follows this sequence:'),
      spacer(),
      twoColTable([
        ['1. Orders',         'Both players secretly submit orders for all their armies simultaneously.'],
        ['2. Resolution',     'The app resolves all movement. Armies entering the same region as an enemy trigger an encounter.'],
        ['3. Force or Refuse','Each player declares whether to force battle, accept it, or refuse (retreat). Feints may create phantom contacts.'],
        ['4. Battle',         'Any triggered battles are fought in FoG2. Results are entered into the app.'],
        ['5. End of Turn',    'Supply is calculated, attrition applied, uncontested regions occupied, Italian loyalty checked, and the turn counter advanced.'],
        ['Winter (turn 8)',   'After turn 8, the Winter Phase begins \u2014 naval bidding, recruitment, recovery, and Victory Point scoring.'],
      ]),

      spacer(),

      // ── Orders & Initiative ──────────────────────────────────────────────
      h1('Orders & Initiative'),
      body('Each player has 4 Initiative Points (IP) per season. Most orders are free; some cost IP:'),
      spacer(),
      twoColTable([
        ['Hold',               'Army stays in place \u2014 free'],
        ['Move',               'Army moves to adjacent region \u2014 free (sea crossing without naval control costs 1 IP and requires a 4+ roll)'],
        ['Scout',              '1 IP \u2014 roll 4+ to reveal an enemy army\u2019s position (can be fooled by a feint)'],
        ['Deep Scout',         '2 IP \u2014 always succeeds; also reveals condition and pierces feints'],
        ['Feint',              '1 IP \u2014 plant a false position marker; enemy scouts and contacts may be fooled for one turn'],
        ['Establish Depot',    '1 IP \u2014 place a supply depot in a friendly-controlled region'],
        ['Siege',              '1 IP \u2014 advance breach points against a fortified strategic point (requires siege equipment purchased in winter)'],
      ]),
      spacer(),
      body('Winning battles earns +1 IP immediately. IP does not carry over between seasons.'),

      spacer(),

      // ── Supply & Attrition ───────────────────────────────────────────────
      h1('Supply & Attrition'),
      body('At the end of every turn the app calculates each army\u2019s supply status. An army is in supply if it is within two regions of its home base or a friendly depot, without enemy armies blocking the path.'),
      spacer(),
      body('Attrition is then applied based on supply status and territory control:'),
      spacer(),
      twoColTable([
        ['In supply, friendly territory',   'No attrition'],
        ['In supply, enemy territory',       '1 point \u2014 no immediate drop (but compounds with battle losses)'],
        ['Out of supply, friendly territory','1 point \u2014 no immediate drop'],
        ['Out of supply, enemy territory',   '2 points \u2014 army loses one condition step every turn'],
      ]),
      spacer(),
      note('Attrition points combine with battle losses in the same turn. 2 pts total = \u22121 step; 3 pts = \u22122 steps.'),
      spacer(),
      body('Depots extend supply reach. They are destroyed if an enemy army occupies their region after battle.'),

      spacer(),

      // ── Battles ──────────────────────────────────────────────────────────
      h1('Battles (Field of Glory 2)'),
      body('When armies from both sides occupy the same region and at least one player forces or accepts battle, the encounter is fought in FoG2. Build your list to your army\u2019s current points budget, then play the battle and record the result in the app.'),
      spacer(),
      h2('Recording Results'),
      body('The player who won enters:'),
      bullet('Winner (Rome or Carthage)', ''),
      bullet('Result type \u2014 Minor loss (loser withdraws) or Decisive loss (loser takes significant casualties)', ''),
      bullet('Where the loser retreats to (optional \u2014 the app auto-selects if left blank)', ''),
      bullet('If the loser had a secondary army in the region: hold in place or retreat with the primary', ''),
      spacer(),
      h2('Battle Effects'),
      twoColTable([
        ['Minor loss',   'Loser\u2019s primary army takes +1 attrition point on top of supply attrition for the turn'],
        ['Decisive loss','As above, plus an immediate additional condition step drop'],
        ['Victory',      'Winner gains +1 IP and +1 VP; each destroyed army grants +2 VP'],
        ['Decisive win', 'Winner\u2019s armies gain an experience step; adjacent Italian regions may be destabilised'],
      ]),
      spacer(),
      h2('Combined Armies'),
      body('Two friendly armies may freely stack in the same region. If a battle occurs:'),
      bullet('The stronger army (best condition + experience) is the Primary and fights at full strength', ''),
      bullet('The weaker army is Support and contributes +10% to the Primary\u2019s points budget', ''),
      bullet('Only the Primary army takes condition damage from the battle result', ''),
      bullet('After battle the Support army may retreat with the Primary or hold in place', ''),

      spacer(),

      // ── Naval Control ────────────────────────────────────────────────────
      h1('Naval Control'),
      body('At each Winter Phase both sides secretly bid 0\u20132 resources on naval supremacy. The higher bid wins naval control for the coming season; a tie results in contested control.'),
      spacer(),
      twoColTable([
        ['Naval control',    'Holder can use sea lanes freely; opponent cannot (without a risky forced crossing). Grants +1 resource income per season. Enemy armies on islands are treated as out of supply at winter.'],
        ['Contested',        'Both sides may use sea lanes. No income bonus. Neither side\u2019s island armies are auto-evacuated.'],
        ['Forced crossing',  'No naval control required \u2014 costs 1 IP, roll 1d6: 4+ succeeds (army arrives out of supply regardless of depots), 1\u20133 fails (army stays, IP spent). The naval-holding side is always informed of the attempt.'],
      ]),

      spacer(),

      // ── Italian Loyalty ──────────────────────────────────────────────────
      h1('Italian Loyalty & Defection'),
      body('Six Italian regions (Etruria, Umbria/Picenum, Campania, Samnium/Lucania, Bruttium/Calabria, Cisalpine Gaul) have a loyalty rating. Rome cannot recapture these by military occupation alone \u2014 they must be recovered politically.'),
      spacer(),
      body('When Carthage wins a battle in Italy:'),
      bullet('Any victory \u2014 the battle region rolls for defection (modified by crushing victory, Rome\u2019s army strength in Italy, and Carthage\u2019s time present)', ''),
      bullet('Decisive victory \u2014 adjacent Italian regions are also destabilised', ''),
      spacer(),
      body('A destabilised region rolls for defection when any Carthage army enters it, unless a Good or Worn Roman army is present (which suppresses the roll). All destabilised flags are cleared if Rome wins any battle in Italy.'),
      spacer(),
      body('Conversely, if Rome moves a Good or Worn army into a defected region and holds it for enough turns, loyalty is gradually recovered.'),

      spacer(),

      // ── Winter Phase ─────────────────────────────────────────────────────
      h1('Winter Phase'),
      body('After turn 8 the season ends. Winter resolves in the following order:'),
      spacer(),
      twoColTable([
        ['Income',          'Each side gains resources: 1 per 3 controlled regions + 1 for naval control + 1 per battle won this season'],
        ['Naval bid',       'Both players secretly bid 0\u20132 resources; higher bid wins naval control for next season'],
        ['Recruitment',     'Spend resources to raise new armies, purchase siege equipment, or hire mercenaries/allied contingents'],
        ['Winter attrition','Out-of-supply armies lose 2 condition steps and cannot recover; island armies without sea access are auto-evacuated'],
        ['Recovery',        'Armies at home base recover to Good; in-supply armies elsewhere recover 1 step'],
        ['VP snapshot',     'Victory Points scored: 1 per 3 regions controlled + 1 per fortified city held + 2 for Sicily'],
        ['Banking cap',     'Unspent resources above 3 are lost at season end'],
      ]),

      spacer(),

      // ── Victory ──────────────────────────────────────────────────────────
      h1('Victory'),
      body('Victory Points are scored at each Winter Phase. After Year 5 (214 BC), the side with more VP wins. Carthage wins a tie.'),
      spacer(),
      body('Sudden death: capturing the enemy capital\u2019s fortified strategic point (Rome or Carthage) ends the game immediately.'),

      spacer(),

      // ── Quick Reference ──────────────────────────────────────────────────
      h1('Quick Reference'),
      h2('Condition Scale'),
      body('Good \u2192 Worn \u2192 Depleted \u2192 Broken \u2192 Destroyed'),
      spacer(),
      h2('Attrition Thresholds (per turn)'),
      body('1 point = no drop (compounds with battle)  |  2 points = \u22121 step  |  3 points = \u22122 steps'),
      spacer(),
      h2('Sea Lanes'),
      body('Hispania Ulterior \u2194 Numidia West  |  Sicily \u2194 Africa Proper  |  Sicily \u2194 Numidia East  |  Sicily \u2194 Bruttium  |  Sardinia & Corsica \u2194 Africa Proper  |  Sardinia & Corsica \u2194 Liguria  |  Venetia \u2194 Illyria'),
      spacer(),
      h2('Home Bases (permanent supply, cannot be flipped by occupation)'),
      body('Rome: Latium  |  Carthage: Africa Proper'),

      spacer(),
      note('This document covers implemented mechanics as of the current build. Some design-spec features (allied contingent deployment, communication delay) are not yet active.'),
    ],
  }],
});

Packer.toBuffer(doc).then(buf => {
  fs.writeFileSync('Bellum_Punicum_Rules_Overview.docx', buf);
  console.log('Written: Bellum_Punicum_Rules_Overview.docx');
});
