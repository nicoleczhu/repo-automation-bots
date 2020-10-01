// eslint-disable-next-line node/no-extraneous-import
import {Context} from 'probot';
import {logger} from 'gcf-utils';
import {handler} from './auto-label';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const colorsData = require('./colors.json');

export interface DriftRepo {
  github_label: string;
  repo: string;
}

export interface DriftApi {
  github_label: string;
}

interface Label {
  name: string;
}

export async function getDriftRepos() {
  const jsonData = await handler.getDriftFile('public_repos.json');
  if (!jsonData) {
    logger.error(
      new Error('public_repos.json downloaded from Cloud Storage was empty')
    );
    return null;
  }
  return JSON.parse(jsonData).repos as DriftRepo[];
}

export async function getDriftApis() {
  const jsonData = await handler.getDriftFile('apis.json');
  if (!jsonData) {
    logger.error(
      new Error('apis.json downloaded from Cloud Storage was empty')
    );
    return null;
  }
  return JSON.parse(jsonData).apis as DriftApi[];
}

// autoDetectLabel tries to detect the right api: label based on the issue
// title.
//
// For example, an issue titled `spanner/transactions: TestSample failed` would
// be labeled `api: spanner`.
export function autoDetectLabel(
  apis: DriftApi[] | null,
  title: string
): string | undefined {
  if (!apis || !title) {
    return undefined;
  }
  // Regex to match the scope of a Conventional Commit message.
  const conv = /[^(]+\(([^)]+)\):/;
  const match = title.match(conv);

  let firstPart = match ? match[1] : title;

  // Remove common prefixes. For example,
  // https://github.com/GoogleCloudPlatform/java-docs-samples/issues/3578.
  const trimPrefixes = ['com.example.', 'com.google.', 'snippets.'];
  for (const prefix of trimPrefixes) {
    if (firstPart.startsWith(prefix)) {
      firstPart = firstPart.slice(prefix.length);
    }
  }

  if (firstPart.startsWith('/')) firstPart = firstPart.substr(1); // Remove leading /.
  firstPart = firstPart.split(':')[0]; // Before the colon, if there is one.
  firstPart = firstPart.split('/')[0]; // Before the slash, if there is one.
  firstPart = firstPart.split('.')[0]; // Before the period, if there is one.
  firstPart = firstPart.split('_')[0]; // Before the underscore, if there is one.
  firstPart = firstPart.toLowerCase(); // Convert to lower case.
  firstPart = firstPart.replace(/\s/, ''); // Remove spaces.

  // Replace some known firstPart values with their API name.
  const commonConversions = new Map();
  commonConversions.set('video', 'videointelligence');
  firstPart = commonConversions.get(firstPart) || firstPart;

  // Some APIs have "cloud" before the name (e.g. cloudkms and cloudiot).
  const possibleLabels = [`api: ${firstPart}`, `api: cloud${firstPart}`];
  return apis.find(api => possibleLabels.indexOf(api.github_label) > -1)
    ?.github_label;
}

export async function addLabeltoRepoAndIssue(
  owner: string,
  repo: string,
  issueNumber: number,
  issueTitle: string,
  driftRepos: DriftRepo[],
  context: Context
) {
  const driftRepo = driftRepos.find(x => x.repo === `${owner}/${repo}`);
  const res = await context.github.issues
    .listLabelsOnIssue({
      owner,
      repo,
      issue_number: issueNumber,
    })
    .catch(logger.error);
  const labelsOnIssue = res ? res.data : undefined;
  let wasNotAdded = true;
  let autoDetectedLabel: string | undefined;

  if (!driftRepo?.github_label) {
    logger.info(
      `There was no configured match for the repo ${repo}, trying to auto-detect the right label`
    );
    const apis = await handler.getDriftApis();
    autoDetectedLabel = autoDetectLabel(apis, issueTitle);
  }
  const index = driftRepos?.findIndex(r => driftRepo === r) % colorsData.length;
  const colorNumber = index >= 0 ? index : 0;
  const githubLabel = driftRepo?.github_label || autoDetectedLabel;

  if (githubLabel) {
    try {
      await context.github.issues.createLabel({
        owner,
        repo,
        name: githubLabel,
        color: colorsData[colorNumber].color,
      });
      logger.info(`Label added to ${owner}/${repo} is ${githubLabel}`);
    } catch (e) {
      // HTTP 422 means the label already exists on the repo
      if (e.status !== 422) {
        e.message = `Error creating label: ${e.message}`;
        logger.error(e);
      }
    }
    if (labelsOnIssue) {
      const foundAPIName = labelsOnIssue.find(
        (element: Label) => element.name === githubLabel
      );
      const cleanUpOtherLabels = labelsOnIssue.filter(
        (element: Label) =>
          element.name.startsWith('api') &&
          element.name !== foundAPIName?.name &&
          element.name !== autoDetectedLabel
      );
      if (foundAPIName) {
        logger.info('The label already exists on this issue');
      } else {
        await context.github.issues
          .addLabels({
            owner,
            repo,
            issue_number: issueNumber,
            labels: [githubLabel],
          })
          .catch(logger.error);
        logger.info(
          `Label added to ${owner}/${repo} for issue ${issueNumber} is ${githubLabel}`
        );
        wasNotAdded = false;
      }
      for (const dirtyLabel of cleanUpOtherLabels) {
        await context.github.issues
          .removeLabel({
            owner,
            repo,
            issue_number: issueNumber,
            name: dirtyLabel.name,
          })
          .catch(logger.error);
      }
    } else {
      await context.github.issues
        .addLabels({
          owner,
          repo,
          issue_number: issueNumber,
          labels: [githubLabel],
        })
        .catch(logger.error);
      logger.info(
        `Label added to ${owner}/${repo} for issue ${issueNumber} is ${githubLabel}`
      );
      wasNotAdded = false;
    }
  }

  let foundSamplesTag: Label | undefined;
  if (labelsOnIssue) {
    foundSamplesTag = labelsOnIssue.find(e => e.name === 'samples');
  }
  const isSampleIssue =
    repo.includes('samples') || issueTitle?.includes('sample');
  if (!foundSamplesTag && isSampleIssue) {
    await context.github.issues
      .createLabel({
        owner,
        repo,
        name: 'samples',
        color: colorsData[colorNumber].color,
      })
      .catch(logger.error);
    await context.github.issues
      .addLabels({
        owner,
        repo,
        issue_number: issueNumber,
        labels: ['samples'],
      })
      .catch(logger.error);
    logger.info(
      `Issue ${issueNumber} is in a samples repo but does not have a sample tag, adding it to the repo and issue`
    );
    wasNotAdded = false;
  }

  return wasNotAdded;
}
