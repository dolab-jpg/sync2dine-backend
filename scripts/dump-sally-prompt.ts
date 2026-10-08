/**
 * Dump assembled Sally phone prompts per mode (read-only audit aid).
 * Run: npx tsx --env-file=.env scripts/dump-sally-prompt.ts
 * Optional: --write writes docs/SALLY_PROMPT_AUDIT.md
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSallyBrainPrompt } from '../server/phone/sally-sales-phone.ts';
import { inboundReceptionFirstMessage } from '../server/brains/sally/index.ts';
import {
  SALLY_EMPLOYER,
  SALLY_EMPLOYER_SPOKEN,
  SALLY_EMPLOYER_URL,
  SALLY_PRODUCT_SYNC2DINE,
  SALLY_SYNC2GEAR_SELL_FACTS,
} from '../server/sally/brand.ts';
import { BDIDDIES_COMPANY } from '../server/home-org.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const write = process.argv.includes('--write');

type Mode = {
  id: string;
  title: string;
  firstMessageHint?: string;
  input: Parameters<typeof buildSallyBrainPrompt>[0];
};

const modes: Mode[] = [
  {
    id: 'inbound_reception',
    title: 'Public inbound (company receptionist)',
    firstMessageHint: inboundReceptionFirstMessage(),
    input: {
      partyPhone: '+441234567890',
      direction: 'inbound',
    },
  },
  {
    id: 'outbound_sales',
    title: 'Outbound sales',
    input: {
      partyPhone: '+447700900111',
      direction: 'outbound',
      contactName: 'Alex',
      companyHint: 'The Chippy',
      outboundBrief: 'Cold dial — Atmosphere + Judie discovery.',
    },
  },
  {
    id: 'outbound_recruitment',
    title: 'Outbound recruitment interview',
    input: {
      partyPhone: '+447700900222',
      direction: 'outbound',
      contactName: 'Sam',
      callMeta: { aim: 'recruitment_interview', source: 'indeed' },
      outboundBrief: 'Restaurant sales role screen.',
    },
  },
  {
    id: 'owner_hiring_ops',
    title: 'Owner mobile inbound (founder ops)',
    input: {
      partyPhone: '+447576442345',
      direction: 'inbound',
      ownerHiringOps: true,
      staffMode: true,
      staffName: 'Shervin',
      staffRole: 'super_admin',
      phoneAuthVerified: false,
    },
  },
  {
    id: 'staff_pin',
    title: 'Staff inbound (PIN gate)',
    input: {
      partyPhone: '+447700900333',
      direction: 'inbound',
      staffMode: true,
      staffName: 'Casey',
      staffRole: 'manager',
      phoneAuthVerified: false,
    },
  },
];

function section(title: string, body: string): string {
  return `## ${title}\n\n${body.trim()}\n`;
}

function main() {
  const generatedAt = new Date().toISOString();
  const parts: string[] = [
    '# Sally phone prompt audit',
    '',
    `Generated: ${generatedAt}`,
    '',
    'Sally-local employer (does **not** change `BDIDDIES_COMPANY`):',
    '',
    `- Employer: **${SALLY_EMPLOYER}** (${SALLY_EMPLOYER_SPOKEN}) · ${SALLY_EMPLOYER_URL}`,
    `- Product line: **${SALLY_PRODUCT_SYNC2DINE}**`,
    `- Platform tenant (untouched): **${BDIDDIES_COMPANY.companyName}** / spoken \`${BDIDDIES_COMPANY.spokenCompanyName}\``,
    '',
    '## Locked Sync2Gear / FloorMix sell facts',
    '',
    ...SALLY_SYNC2GEAR_SELL_FACTS.map((l) => `- ${l}`),
    '',
    '## Modes',
    '',
  ];

  for (const mode of modes) {
    const { instructions } = buildSallyBrainPrompt(mode.input);
    parts.push(section(
      mode.title,
      [
        `Mode id: \`${mode.id}\``,
        mode.firstMessageHint ? `First message hint: *${mode.firstMessageHint}*` : '',
        '',
        '```',
        instructions,
        '```',
      ].filter(Boolean).join('\n'),
    ));
  }

  const md = `${parts.join('\n')}\n`;
  if (write) {
    const out = join(ROOT, 'docs', 'SALLY_PROMPT_AUDIT.md');
    writeFileSync(out, md, 'utf8');
    console.log(`Wrote ${out} (${md.length} chars)`);
  } else {
    process.stdout.write(md);
  }
}

main();
