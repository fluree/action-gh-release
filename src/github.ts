import { GitHub } from "@actions/github";
import { Config, releaseBody } from "./util";
import { lstatSync, readFileSync } from "fs";
import { getType } from "mime";
import { basename } from "path";

export interface ReleaseAsset {
  name: string;
  mime: string;
  size: number;
  file: Buffer;
}

export interface Release {
  id: number;
  upload_url: string;
  html_url: string;
  tag_name: string;
  body: string;
  target_commitish: string;
}

export interface Releaser {
  getReleaseByTag(params: {
    owner: string;
    repo: string;
    tag: string;
  }): Promise<{ data: Release }>;

  findRelease(params: {
    owner: string;
    repo: string;
    tag: string;
    draft: boolean;
  }): Promise<{ data: Release }>;

  createRelease(params: {
    owner: string;
    repo: string;
    tag_name: string;
    name: string;
    body: string | undefined;
    draft: boolean | undefined;
    prerelease: boolean | undefined;
  }): Promise<{ data: Release }>;

  updateRelease(params: {
    owner: string;
    repo: string;
    release_id: number;
    tag_name?: string;
    target_commitish?: string;
    name?: string;
    body?: string;
    draft?: boolean | undefined;
    prerelease?: boolean | undefined;
  }): Promise<{ data: Release }>;

  allReleases(params: {
    owner: string;
    repo: string;
  }): AsyncIterableIterator<{ data: Release[] }>;
}

export class GitHubReleaser implements Releaser {
  github: GitHub;
  constructor(github: GitHub) {
    this.github = github;
  }

  getReleaseByTag(params: {
    owner: string;
    repo: string;
    tag: string;
  }): Promise<{ data: Release }> {
    return this.github.repos.getReleaseByTag(params);
  }

  async findRelease(params: {
    owner: string;
    repo: string;
    tag: string;
    draft: boolean;
  }): Promise<{ data: Release }> {
    // you can't get a an existing draft by tag
    // so we must find one in the list of all releases
    if (params.draft) {
      console.log(`Looking for draft release with tag: ${params.tag}`)
      for await (const response of this.allReleases(params)) {
        let release = response.data.find(
          release => release.tag_name === params.tag
        );
        if (release) {
          console.log(`Found draft release: ${release.tag_name}`)
          return { data: release };
        }
      }
    }
    console.log(`Looking for non-draft release with tag: ${params.tag}`)
    return await this.getReleaseByTag(params);
  }

  createRelease(params: {
    owner: string;
    repo: string;
    tag_name: string;
    name: string;
    body: string | undefined;
    draft: boolean | undefined;
    prerelease: boolean | undefined;
  }): Promise<{ data: Release }> {
    return this.github.repos.createRelease(params);
  }

  updateRelease(params: {
    owner: string;
    repo: string;
    release_id: number;
    tag_name: string | undefined;
    target_commitish: string | undefined;
    name: string | undefined;
    body: string | undefined;
    draft: boolean | undefined;
    prerelease: boolean | undefined;
  }): Promise<{ data: Release }> {
    return this.github.repos.updateRelease(params);
  }

  allReleases(params: {
    owner: string;
    repo: string;
  }): AsyncIterableIterator<{ data: Release[] }> {
    const updatedParams = { per_page: 100, ...params };
    return this.github.paginate.iterator(
      this.github.repos.listReleases.endpoint.merge(updatedParams)
    );
  }
}

export const asset = (path: string): ReleaseAsset => {
  return {
    name: basename(path),
    mime: mimeOrDefault(path),
    size: lstatSync(path).size,
    file: readFileSync(path)
  };
};

export const mimeOrDefault = (path: string): string => {
  return getType(path) || "application/octet-stream";
};

export const upload = async (
  gh: GitHub,
  url: string,
  path: string
): Promise<any> => {
  let { name, size, mime, file } = asset(path);
  console.log(`⬆️ Uploading ${name}...`);
  return await gh.repos.uploadReleaseAsset({
    url,
    headers: {
      "content-length": size,
      "content-type": mime
    },
    name,
    file
  });
};

export const release = async (
  config: Config,
  releaser: Releaser
): Promise<Release> => {
  const [owner, repo] = config.github_repository.split("/");
  const tag =
    config.input_tag_name || config.github_ref.replace("refs/tags/", "");
  try {
    const existingRelease = await releaser.findRelease({
      owner: owner,
      repo: repo,
      tag: tag,
      draft: config.input_draft || false
    });

    const release_id = existingRelease.data.id;
    const target_commitish = existingRelease.data.target_commitish;
    const tag_name = tag;
    const name = config.input_name || tag;
    const body = `${existingRelease.data.body}\n${releaseBody(config)}`;
    const draft = config.input_draft;
    const prerelease = config.input_prerelease;

    const release = await releaser.updateRelease({
      owner,
      repo,
      release_id,
      tag_name,
      target_commitish,
      name,
      body,
      draft,
      prerelease
    });
    return release.data;
  } catch (error) {
    if (error.status === 404) {
      const tag_name = tag;
      const name = config.input_name || tag;
      const body = releaseBody(config);
      const draft = config.input_draft;
      const prerelease = config.input_prerelease;
      console.log(`👩‍🏭 Creating new GitHub release for tag ${tag_name}...`);
      try {
        let release = await releaser.createRelease({
          owner,
          repo,
          tag_name,
          name,
          body,
          draft,
          prerelease
        });
        return release.data;
      } catch (error) {
        // presume a race with competing metrix runs
        console.log(
          `⚠️ GitHub release failed with status: ${error.status}, retrying...`
        );
        return release(config, releaser);
      }
    } else {
      console.log(
        `⚠️ Unexpected error fetching GitHub release for tag ${config.github_ref}: ${error}`
      );
      throw error;
    }
  }
};

export const publishRelease = async (
  config: Config,
  releaseId: number,
  releaser: Releaser
): Promise<Release> => {
  const [owner, repo] = config.github_repository.split("/");
  const tag =
    config.input_tag_name || config.github_ref.replace("refs/tags/", "");
  const publishedRelease = await releaser.updateRelease({
    owner: owner,
    repo: repo,
    release_id: releaseId,
    draft: false
  });
  return publishedRelease.data;
};
