// pi-harvester/bot-login.mjs — LOCAL one-time Bot_Session login CLI.
//
// Feature: pi-scrape-pipeline — Task 8 (One-time Bot login tool, LOCAL).
//
// This is one of only two components permitted to run on the operator's local
// machine (the other is the Key_Harvester, Task 10). It is a ONE-TIME tool: run
// it once to establish the dedicated Bot_Session and seed the Token_Store with
// {PW_BOT_REFRESH_TOKEN, PW_BOT_RANDOM_ID}; thereafter the remote pipeline only
// ever refreshes.
//
// All the login logic lives in the shared, dependency-injected core
// (codespaces/pi-pipeline/src/bot-login.mjs) so it runs in CI under node --test
// with a fake network + fake OTP. This file only WIRES that core to the real
// world: the global fetch, an interactive terminal OTP prompt, a fresh uuid
// randomId, and a Token_Store backend (GitHub repo secrets in production, or a
// local JSON file for a dry run / offline seed).
//
// The bot logs in under its OWN fresh uuid `randomId`, distinct from the
// operator's interactive browser session, so the bot's refresh-token rotation
// can never invalidate the interactive session and vice versa (Req 5.1, 5.5,
// 5.6, 7.2).
//
// Usage:
//   node pi-harvester/bot-login.mjs --username <phone> [--country-code +91]
//     --store github --owner jokukiller --repo piratewallah-codespaces --gh-token <tok>
//   node pi-harvester/bot-login.mjs --username <phone> --store local --token-file ./bot-token.json
//
// _Requirements: 5.1, 5.3, 5.4, 5.5, 5.6, 7.2_

import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

import {
  createBotLogin,
  BotLoginError,
  BOT_LOGIN_ERROR,
} from '../../../codespaces/pi-pipeline/src/bot-login.mjs';
import {
  createGitHubSecretsTokenStore,
  createLocalFileTokenStore,
} from '../../../codespaces/pi-pipeline/src/token-store.mjs';
import {
  TOKEN_STORE_REPO,
  PW_DEFAULT_COUNTRY_CODE,
} from '../../../codespaces/pi-pipeline/src/constants.mjs';

/** Parse `--flag value` / `--flag` CLI args into a plain object. */
export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (!tok.startsWith('--')) continue;
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

const USAGE = `Bot_Session login (LOCAL, one-time)

Usage:
  node pi-harvester/bot-login.mjs --username <phone> [--country-code ${PW_DEFAULT_COUNTRY_CODE}] <store options>

Store options:
  --store github   seed GitHub repo secrets (PW_BOT_REFRESH_TOKEN, PW_BOT_RANDOM_ID)
    [--owner <o>] [--repo <r>]   default: ${TOKEN_STORE_REPO}
    --gh-token <token>            GitHub token with 'repo' scope (or env GH_TOKEN)
  --store local    write a local JSON file (dry-run / offline seed)
    --token-file <path>           destination JSON file

Notes:
  - LOCAL-ONLY tool (Req 14.1). Logs in under a FRESH uuid randomId distinct from
    the interactive browser session, so rotation never clobbers that session
    (Req 5.1, 5.5, 5.6, 7.2).
  - On login failure NOTHING is written and the failure is reported (Req 5.3).
  - On Token_Store write failure the Bot_Session is treated as NOT established
    (Req 5.4).
`;

/** Prompt the operator for the OTP on the terminal. */
function promptOtp(promptText = 'Enter the OTP sent to the bot number: ') {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(promptText, (answer) => {
      rl.close();
      const trimmed = (answer ?? '').trim();
      if (!trimmed) {
        reject(new Error('no OTP entered'));
        return;
      }
      resolve(trimmed);
    });
  });
}

/** Build the Token_Store backend selected by --store. */
function buildTokenStore(args) {
  const store = args.store ?? 'github';
  if (store === 'local') {
    if (typeof args['token-file'] !== 'string') {
      throw new Error('--store local requires --token-file <path>');
    }
    return createLocalFileTokenStore({ filePath: args['token-file'] });
  }
  if (store === 'github') {
    const [defaultOwner, defaultRepo] = TOKEN_STORE_REPO.split('/');
    const owner = typeof args.owner === 'string' ? args.owner : defaultOwner;
    const repo = typeof args.repo === 'string' ? args.repo : defaultRepo;
    const token =
      (typeof args['gh-token'] === 'string' && args['gh-token']) ||
      process.env.GH_TOKEN ||
      process.env.GITHUB_TOKEN;
    if (!token) {
      throw new Error('--store github requires --gh-token or env GH_TOKEN/GITHUB_TOKEN');
    }
    return createGitHubSecretsTokenStore({ owner, repo, token });
  }
  throw new Error(`unknown --store "${store}" (expected github|local)`);
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help || !args.username) {
    process.stdout.write(USAGE);
    return args.help ? 0 : 2;
  }

  let tokenStore;
  try {
    tokenStore = buildTokenStore(args);
  } catch (err) {
    process.stderr.write(`Configuration error: ${err.message}\n\n${USAGE}`);
    return 2;
  }

  const bot = createBotLogin({ otpProvider: () => promptOtp(), tokenStore });

  process.stdout.write('Requesting OTP for the dedicated bot session...\n');
  try {
    const { randomId } = await bot.login({
      username: String(args.username),
      countryCode: typeof args['country-code'] === 'string' ? args['country-code'] : undefined,
    });
    process.stdout.write(
      `\nBot_Session established. Seeded Token_Store with the rotated refresh token and ` +
        `randomId ${randomId}.\nThe remote pipeline will read these on its next run.\n`,
    );
    return 0;
  } catch (err) {
    if (err instanceof BotLoginError) {
      if (err.code === BOT_LOGIN_ERROR.PERSIST_FAILED) {
        // Req 5.4: persistence failed -> Bot_Session NOT established.
        process.stderr.write(
          `Token_Store persistence FAILED — Bot_Session NOT established. Nothing usable was ` +
            `stored. ${err.message}\n`,
        );
        return 4;
      }
      // Req 5.3: login did not complete -> nothing was written.
      process.stderr.write(
        `Bot_Session login did NOT complete; nothing was written to the Token_Store. ` +
          `${err.message}\n`,
      );
      return 3;
    }
    process.stderr.write(`Unexpected error during bot login: ${err?.stack || err}\n`);
    return 1;
  }
}

// Run only when invoked directly, not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code ?? 0),
    (err) => {
      process.stderr.write(`${err?.stack || err}\n`);
      process.exit(1);
    },
  );
}
