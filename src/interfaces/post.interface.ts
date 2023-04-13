export interface PatreonPost {
  attributes: {
    title: string;
    content?: string;
    embed?: {
      url?: string;
      provider?: ProviderType;
      subject?: string;
      description?: string;
    };
    post_type: PostType;
  };
}

export interface PatreonPostList {
  data: PatreonPost[];
  links: {
    first: string;
    next?: string;
  };
}

export interface Post extends BasicPost {
  title: string;
  type: PostType;
  description?: string;
  uploadTime?: string;
  lastSync?: string;
}

export interface BasicPost {
  link: string;
  providerName?: string;
  videoId?: string;
}

export enum PostType {
  video = 'video_embed',
  livestream = 'livestream_youtube',
  link = 'link',
}

export enum ProviderType {
  youtube = 'YouTube',
  vimeo = 'Vimeo',
  bitchute = 'BitChute',
}
