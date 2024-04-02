#!/usr/bin/env node

import axios from 'axios';
import pLimit from 'p-limit';
import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';
const argv = yargs(hideBin(process.argv)).argv;

/**
 * @type {string[]}
 */
const ORGANIZATIONS = (argv.organizations || '')
  .split(/\s|,/)
  .map((o) => o.trim());
const TOKEN = argv.token || process.env.GITHUB_TOKEN;

const IGNORE = (argv.ignore || '')?.split(/\s|,/)?.map((i) => i.trim().toLowerCase()) || [];
const CURRENT_REPO = (argv.repo || process.env.GITHUB_REPOSITORY)?.toLowerCase();

IGNORE.push(
  CURRENT_REPO,
  'utilcode/auto-delete-repo',
  'utilcode/simple-template',
  'utilcode/simple-template-advanced'
);

const githubLimit = pLimit(10);
const npmLimit = pLimit(10);

async function* getListOfRepos(org) {
  let page = 1;
  const limit = 100;
  let response;
  do {
    response = await githubLimit(() =>
      axios.get(
        `https://api.github.com/orgs/${org}/repos?per_page=${limit}&page=${page}`,
        {
          headers: {
            Authorization: `Bearer ${TOKEN}`,
          },
        }
      )
    );

    for (const repo of response.data) {
      yield repo;
    }
    page++;
  } while (response.data.length === limit);
}

async function main() {
  const deleteList = [];
  for (let org of ORGANIZATIONS) {
    const awaitList = [];
    for await (const repo of getListOfRepos(org)) {
      const repoNameLower = repo.full_name.toLowerCase();
      // get packge json file
      if (IGNORE.includes(repoNameLower) || repoNameLower === CURRENT_REPO) {
        console.log('Skipping %s', repo.full_name);
        continue;
      }

      awaitList.push(
        githubLimit(async () => {
          const { data: packageJson } = await axios.get(
            `https://raw.githubusercontent.com/${repo.full_name}/main/package.json`,
            {
              headers: {
                Authorization: `Bearer ${TOKEN}`,
              },
              responseType: 'json',
            }
          );

          if (packageJson.name) {
            const packageName = packageJson.name;

            if (IGNORE.includes(packageName.toLowerCase())) {
              console.log('Skipping %s', packageName);
              return;
            }

            await npmLimit(async () => {
              try {
                await axios.get(`https://registry.npmjs.org/${packageName}`, {
                  responseType: 'json',
                });

                console.log(
                  'NPM package found: %s for repo %s. No need to delete',
                  packageName,
                  repo.full_name
                );
              } catch (err) {
                if (err && err.response && err.response.status === 404) {
                  deleteList.push(repo.full_name);
                  return;
                }

                console.log('Unexpected error', err);
              }
            });
          }
        })
      );
    }

    await Promise.all(awaitList);
  }

  console.log('Deleting repos', deleteList);

  const awaitList = [];

  for (let repo of deleteList) {
    awaitList.push(
      githubLimit(async () => {
        try {
          await axios.delete(`https://api.github.com/repos/${repo}`, {
            headers: {
              Authorization: `Bearer ${TOKEN}`,
            },
          });

          console.log('Deleted repo %s', repo);
        } catch (err) {
          console.log('Failed to delete repo %s', repo, err);
        }
      })
    );
  }

  await Promise.all(awaitList);
}

main();
