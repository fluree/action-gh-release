import { paths, parseConfig, isTag, unmatchedPatterns } from "./util";
import { release, upload, publishRelease, GitHubReleaser } from "./github";
import { setFailed, setOutput } from "@actions/core";
import { GitHub } from "@actions/github";
import { env } from "process";

async function run() {
  try {
    const config = parseConfig(env);
    if (!config.input_tag_name && !isTag(config.github_ref)) {
      throw new Error(`⚠️ GitHub Releases requires a tag`);
    }
    if (config.input_files) {
      const patterns = unmatchedPatterns(config.input_files);
      patterns.forEach(pattern =>
        console.warn(`🤔 Pattern '${pattern}' does not match any files.`)
      );
      if (patterns.length > 0 && config.input_fail_on_unmatched_files) {
        throw new Error(`⚠️ There were unmatched files`);
      }
    }
    GitHub.plugin([
      require("@octokit/plugin-throttling"),
      require("@octokit/plugin-retry")
    ]);
    const gh = new GitHub(config.github_token, {
      throttle: {
        onRateLimit: (retryAfter, options) => {
          console.warn(
            `Request quota exhausted for request ${options.method} ${options.url}`
          );
          if (options.request.retryCount === 0) {
            // only retries once
            console.log(`Retrying after ${retryAfter} seconds!`);
            return true;
          }
        },
        onAbuseLimit: (retryAfter, options) => {
          // does not retry, only logs a warning
          console.warn(
            `Abuse detected for request ${options.method} ${options.url}`
          );
        }
      }
    });
    let initialConfig = config;
    if (config.input_draft_until_assets_uploaded) {
      console.log(`📝 Marking release as draft until all assets are uploaded`);
      initialConfig.input_draft = true;
    }
    let releaser = new GitHubReleaser(gh);
    let rel = await release(initialConfig, releaser);
    if (config.input_files) {
      const files = paths(config.input_files);
      if (files.length == 0) {
        console.warn(`🤔 ${config.input_files} does not include valid file(s).`);
      }
      files.forEach(async path => {
        await upload(gh, rel.upload_url, path);
      });
    }
    if (config.input_draft_until_assets_uploaded && !config.input_draft) {
      console.log(`📰 Publishing draft release`);
      const releaseId = rel.id;
      await publishRelease(config, releaseId, releaser);
    }
    console.log(`🎉 Release ready at ${rel.html_url}`);
    setOutput("url", rel.html_url);
    setOutput("upload_url", rel.upload_url);
  } catch (error) {
    setFailed(error.message);
  }
}

run();
