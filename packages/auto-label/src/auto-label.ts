// Copyright 2020 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {Storage} from '@google-cloud/storage';
// eslint-disable-next-line node/no-extraneous-import
import {Application} from 'probot';
import {logger} from 'gcf-utils';
import * as product from './product-label';

const storage = new Storage();
handler.getDriftFile = async (file: string) => {
  const bucket = 'devrel-prod-settings';
  const [contents] = await storage.bucket(bucket).file(file).download();
  return contents.toString();
};

// Attach functions to exported handler for easy testing
handler.getDriftRepos = product.getDriftRepos;
handler.getDriftApis = product.getDriftApis;
handler.addLabeltoRepoAndIssue = product.addLabeltoRepoAndIssue;

/**
 * Main function, responds to label being added
 */
export function handler(app: Application) {
  app.on(['issues.opened', 'issues.reopened'], async context => {
    //job that labels issues when they are opened
    const owner = context.payload.repository.owner.login;
    const repo = context.payload.repository.name;
    const issueNumber = context.payload.issue.number;
    const driftRepos = await handler.getDriftRepos();
    if (!driftRepos) {
      return;
    }
    await handler.addLabeltoRepoAndIssue(
      owner,
      repo,
      issueNumber,
      context.payload.issue.title,
      driftRepos,
      context
    );
  });

  // nightly cron that backfills and corrects api labels
  // Latest Probot doesn't handle schedule events in favor of Github Actions
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.on('schedule.repository' as any, async context => {
    logger.info(`running for org ${context.payload.cron_org}`);
    const owner = context.payload.organization.login;
    const repo = context.payload.repository.name;
    if (context.payload.cron_org !== owner) {
      logger.info(`skipping run for ${context.payload.cron_org}`);
      return;
    }
    const driftRepos = await handler.getDriftRepos();
    if (!driftRepos) {
      return;
    }
    //all the issues in the repository
    const issues = context.github.issues.listForRepo.endpoint.merge({
      owner,
      repo,
    });
    let labelWasNotAddedCount = 0;
    //goes through issues in repository, adds labels as necessary
    for await (const response of context.github.paginate.iterator(issues)) {
      const issues = response.data;
      for (const issue of issues) {
        const wasNotAdded = await handler.addLabeltoRepoAndIssue(
          owner,
          repo,
          issue.number,
          issue.title,
          driftRepos,
          context
        );
        if (wasNotAdded) {
          logger.info(
            `label for ${issue.number} in ${owner}/${repo} was not added`
          );
          labelWasNotAddedCount++;
        }
        if (labelWasNotAddedCount > 5) {
          logger.info(
            `${
              owner / repo
            } has 5 issues where labels were not added; skipping the rest of this repo check.`
          );
          return;
        }
      }
    }
  });

  app.on(['installation.created'], async context => {
    const repositories = context.payload.repositories;
    const driftRepos = await handler.getDriftRepos();
    if (!driftRepos) {
      return;
    }
    for await (const repository of repositories) {
      const [owner, repo] = repository.full_name.split('/');

      //goes through issues in repository, adds labels as necessary
      for await (const response of context.github.paginate.iterator(
        context.github.issues.listForRepo,
        {
          owner,
          repo,
        }
      )) {
        const issues = response.data;
        //goes through each issue in each page
        for (const issue of issues) {
          await handler.addLabeltoRepoAndIssue(
            owner,
            repo,
            issue.number,
            issue.title,
            driftRepos,
            context
          );
        }
      }
    }
  });
}
