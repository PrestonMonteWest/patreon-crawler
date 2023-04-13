import axios, { AxiosResponse } from 'axios';

if (process.env.NODE_ENV !== 'production') {
  (await import('dotenv')).config();
}

const youtubeApiEndpoint = process.env.YOUTUBE_API_ENDPOINT;

export interface YouTubeVideoQuery {
  id: string;
}

export interface YouTubeVideo {
  id: string;
  title: string;
  description: string;
  publishedAt: string;
}

export interface YouTubeAPIResponse {
  pageInfo: {
    totalResults: number;
    resultsPerPage: number;
  };
  items: YouTubeAPIItem[];
}

export interface YouTubeAPIItem {
  id: string;
  snippet?: {
    publishedAt: string;
    title: string;
    description: string;
  };
}

export class YouTubeClient {
  constructor(private readonly key?: string) {
    if (!this.key) {
      this.key = process.env.YOUTUBE_API_KEY;
    }
  }

  async getVideos(query: YouTubeVideoQuery): Promise<YouTubeVideo[]> {
    if (!query.id) {
      throw new Error('No video Id(s) provided');
    }

    const response = await this.getResources('videos', {
      part: 'snippet',
      id: query.id,
    });

    const numberOfVideos = response.data.pageInfo.totalResults;
    if (!numberOfVideos) {
      throw new Error(`Video(s) not found: ${query.id}`);
    }
    const numberOfIds = query.id.split(',').length;
    if (numberOfVideos !== numberOfIds) {
      throw new Error(
        `${numberOfVideos} video(s) found but ${numberOfIds} Id(s) provided: ${query.id}`
      );
    }

    return response.data.items.map((item) => ({
      id: item.id,
      title: item.snippet!.title,
      description: item.snippet!.description,
      publishedAt: item.snippet!.publishedAt,
    }));
  }

  async getResources(
    resource: string,
    params: Record<string, string>
  ): Promise<AxiosResponse<YouTubeAPIResponse>> {
    try {
      return await axios.get<YouTubeAPIResponse>(
        `https://${youtubeApiEndpoint}/${resource}`,
        {
          headers: { 'x-goog-api-key': this.key },
          params,
        }
      );
    } catch (err) {
      const message = err.response.data.error.message;
      throw new Error(`Error retrieving YouTube resources: ${message}`);
    }
  }

  static getVideoId(link: string) {
    const match = link.match(
      // Copied and modified from stack overflow: https://stackoverflow.com/a/9102270
      /.*youtu\.?be(?:\.com)?\/.*?(?:live\/|v\/|user\/.*\/|embed\/|watch\?.*&?v=)?([^#&?\s]*).*/
    );
    if (!match) {
      throw new Error(`Invalid YouTube link: ${link}`);
    }
    return match[1];
  }
}
