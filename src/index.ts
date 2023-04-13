import axios, { AxiosResponse } from 'axios';
import fs from 'fs';
import pg, { QueryResult } from 'pg';

import { YouTubeClient, YouTubeVideo } from './clients/youtube.client.js';
import {
  BasicPost,
  PatreonPostList,
  Post,
  ProviderType,
} from './interfaces/post.interface.js';
import { off } from 'process';

if (process.env.NODE_ENV !== 'production') {
  (await import('dotenv')).config();
}

const youtubeClient = new YouTubeClient();
const patreonApiEndpoint = process.env.PATREON_API_ENDPOINT;
const jsonApiVersion = 'json-api-version=1.0';
const tenMinutes = 1000 * 60 * 10;

const pool = new pg.Pool();

let nextUrl:
  | string
  | undefined = `${patreonApiEndpoint}/stream?filter%5Bis_following%5D=true&json-api-use-default-includes=false&${jsonApiVersion}`;
let postsMap: Map<string, Post>;

const sessionToken = await login();

while (nextUrl) {
  const lastUrl: string = nextUrl;
  [nextUrl, postsMap] = await retrievePosts(`https://${lastUrl}`);
  await importPosts(postsMap)
    .then((posts) =>
      console.log(`Imported ${posts.length} post(s) for ${lastUrl}`)
    )
    .catch((err) => {
      console.error(err);
      console.error('Import failed for', lastUrl);
      console.error('Posts:', JSON.stringify(Array.from(postsMap.values())));
    });
}

async function login() {
  let sessionCookie: string | undefined;
  try {
    sessionCookie = fs.readFileSync('session.txt', 'utf-8');
  } catch {}

  const expireString = sessionCookie
    ?.split('; ')
    .find((cookieData) => cookieData.startsWith('Expires'))
    ?.split('=')[1];
  const expirationDate = expireString && new Date(expireString);

  if (
    !expirationDate ||
    new Date(expirationDate.getTime() - tenMinutes) <= new Date()
  ) {
    const loginResult = await axios.post(
      `https://${patreonApiEndpoint}/login?${jsonApiVersion}`,
      {
        data: {
          type: 'user',
          attributes: {
            email: process.env.PATREON_EMAIL,
            password: process.env.PATREON_PASSWORD,
          },
        },
      }
    );

    sessionCookie = loginResult.headers['set-cookie']?.find((cookie) =>
      cookie.startsWith('session_id')
    );
  }

  if (!sessionCookie) {
    throw new Error('Patreon session unavailable');
  }

  fs.writeFileSync('session.txt', sessionCookie);

  return sessionCookie.split(';')[0];
}

async function retrievePosts(
  url: string
): Promise<[string | undefined, Map<string, Post>]> {
  const postResult = await axios.get<PatreonPostList>(url, {
    headers: { Cookie: sessionToken },
  });

  const postData = postResult.data;
  const postsMap = new Map<string, Post>();
  const posts = await Promise.all(
    postData.data
      .filter(
        (post) =>
          post.attributes.embed?.url &&
          post.attributes.embed.provider &&
          Object.values(ProviderType).includes(post.attributes.embed.provider)
      )
      .map((patreonPost) => ({
        link: patreonPost.attributes.embed!.url!,
        providerName: patreonPost.attributes.embed!.provider!,
        type: patreonPost.attributes.post_type,
        title:
          patreonPost.attributes.embed!.subject || patreonPost.attributes.title,
        description: patreonPost.attributes.embed!.description,
      }))
  );

  await setYouTubeMetadata(posts);

  for (const post of posts) {
    postsMap.set(getPostKey(post), post);
  }

  return [postData.links.next, postsMap];
}

async function setYouTubeMetadata(posts: Post[]) {
  const youtubePosts = posts
    .filter((post) => post.providerName === ProviderType.youtube)
    .map((post) => {
      try {
        post.videoId = YouTubeClient.getVideoId(post.link) || undefined;
      } catch (err) {
        console.error(err);
      }

      return post;
    })
    .filter((post) => post.videoId);

  let videos: YouTubeVideo[] = [];

  try {
    videos = await youtubeClient.getVideos({
      id: youtubePosts.map((post) => post.videoId!).join(','),
    });
  } catch (err) {
    console.error(err);
    return;
  }

  const lastSync = new Date().toISOString();
  videos.forEach((video, index) => {
    const post =
      youtubePosts.length === videos.length
        ? youtubePosts[index]
        : youtubePosts.find((post) => post.videoId === video.id);
    if (!post) {
      return;
    }

    post.lastSync = lastSync;
    post.title = video.title;
    post.description = video.description;
    post.uploadTime = video.publishedAt;
  });
}

async function importPosts(postsMap: Map<string, Post>): Promise<Post[]> {
  postsMap = await filterPosts(postsMap);

  if (!postsMap.size) {
    return [];
  }

  const posts = Array.from(postsMap.values());
  const values = posts
    .map((post, index) => getPgParamList(index, 8))
    .join(', ');
  const query = `insert into video (import_link, provider_name, video_id, post_type, title, description, upload_time, last_sync) values ${values};`;
  const params = posts.flatMap((post) => [
    post.link,
    post.providerName,
    post.videoId,
    post.type,
    post.title,
    post.description,
    post.uploadTime,
    post.lastSync,
  ]);
  try {
    await pool.query(query, params);
  } catch (err) {
    console.error('query:', query);
    console.error('params:', params);
    throw err;
  }

  return posts;
}

async function filterPosts(
  postsMap: Map<string, Post>
): Promise<Map<string, Post>> {
  const postsWithoutTitle: Post[] = [];
  for (const post of postsMap.values()) {
    if (!post.title) {
      postsWithoutTitle.push(post);
      postsMap.delete(getPostKey(post));
    }
  }

  if (postsWithoutTitle.length) {
    console.warn('Import found posts without title:', postsWithoutTitle);
  }

  if (!postsMap.size) {
    return postsMap;
  }

  const posts = Array.from(postsMap.values());
  const query = `select import_link, provider_name, video_id from video where import_link in (${posts
    .map((post, index) => `$${index + 1}`)
    .join(', ')}) or (provider_name, video_id) in (${posts
    .map((post, index) => getPgParamList(index, 2, posts.length))
    .join(', ')});`;
  const params = posts
    .map<any>((post) => post.link)
    .concat(posts.flatMap((post) => [post.providerName, post.videoId]));
  let duplicateResult: QueryResult<{
    import_link: string;
    provider_name: string | null;
    video_id: string | null;
  }>;
  try {
    duplicateResult = await pool.query(query, params);
  } catch (err) {
    console.error('query:', query);
    console.error('params:', posts);
    throw err;
  }
  for (const row of duplicateResult.rows) {
    const post = {
      link: row.import_link,
      providerName: row.provider_name || undefined,
      videoId: row.video_id || undefined,
    };
    postsMap.delete(getPostKey(post));
  }

  const linkValidationPromises: Promise<{ valid: boolean; post: Post }>[] = [];
  for (const post of postsMap.values()) {
    // YouTube links are validated by the YouTube API
    if (post.providerName !== ProviderType.youtube) {
      linkValidationPromises.push(
        validateLink(post.link).then((result) => ({
          valid: result,
          post,
        }))
      );
    }
  }
  const validations = await Promise.all(linkValidationPromises);
  for (const validation of validations) {
    if (!validation.valid) {
      postsMap.delete(getPostKey(validation.post));
    }
  }

  return postsMap;
}

async function validateLink(link: string): Promise<boolean> {
  let result: AxiosResponse | undefined;

  try {
    result = await axios.head(link);
  } catch (err) {
    if (err.response) {
      result = err.response;
    }
  }

  return result?.status === 200;
}

function getPostKey(post: BasicPost): string {
  if (post.providerName && post.videoId) {
    return post.providerName + ',' + post.videoId;
  }

  return post.link;
}

function getPgParamList(
  factor: number,
  numberOfParams: number,
  offset?: number
) {
  const paramList: string[] = [];
  for (let index = 1; index <= numberOfParams; index++) {
    paramList.push(`$${factor * numberOfParams + index + (offset || 0)}`);
  }

  return `(${paramList.join(', ')})`;
}
