// Trigger bodies, typed with @devvit/web. The fidelity hook in events.test.ts compares keys and types with each real body
// that S3 (plan section 2) captured in test/fixtures/payloads/. S3 confirmed (2026-11-15): PostV2 and CommentV2 times in epoch
// ms; ids with the t1/t2/t3/t5 prefix; PostDelete times as ISO strings; enums as numbers; PostDelete source USER (1) for the
// author and MODERATOR (3) for a mod or the app, reason UNKNOWN (4); an app user has accountType APP; PostV2 has media {type: ''}.
// Still guesses: PostV2 galleryImages only for galleries and mediaUrls for image posts and galleries (the hook does not compare array items).
import type { OnCommentCreateRequest, OnPostDeleteRequest, OnPostFlairUpdateRequest, OnPostSubmitRequest, PostV2, SubredditV2, UserV2, CommentV2 } from '@devvit/web/shared';
import { CrowdControlLevel, DeletionReason, DistinguishType, EventSource, SubredditRating, SubredditType } from '@devvit/web/shared';
import { AccountTypeV2 } from '@devvit/protos/json/devvit/reddit/v2alpha/userv2.js';
import type { Comment, Post, PostKind, Sub, User } from './world';

/** The trigger key of devvit.json for the `type` of each body. */
export const TRIGGER = {
  PostSubmit: 'onPostSubmit',
  PostFlairUpdate: 'onPostFlairUpdate',
  PostDelete: 'onPostDelete',
  CommentCreate: 'onCommentCreate',
} as const;
export type TriggerBody = OnPostSubmitRequest | OnPostFlairUpdateRequest | OnPostDeleteRequest | OnCommentCreateRequest;

const POST_TYPE: Record<PostKind, string> = { image: 'image', gallery: 'gallery', link: 'link', video: 'video', text: 'self', crosspost: 'crosspost' };

export const permalinkOf = (post: Pick<Post, 'id' | 'sub'>) => `/r/${post.sub}/comments/${post.id.slice(3)}/post/`;
export const commentPermalink = (comment: Pick<Comment, 'id' | 'postId' | 'sub'>) =>
  `${permalinkOf({ id: comment.postId, sub: comment.sub })}${comment.id.slice(3)}/`;

/** An author of an event: a user, or a deleted account with no id. */
type Actor = Pick<User, 'name' | 'app'> & { id: string };

export const userV2 = (user: Actor): UserV2 => ({
  id: user.id, name: user.name, isGold: false, snoovatarImage: '', url: `/user/${user.name}/`, spam: false, banned: false, karma: 1,
  iconImage: '', description: '', suspended: false, accountType: user.app ? AccountTypeV2.ACCOUNT_TYPE_APP : AccountTypeV2.ACCOUNT_TYPE_USER,
});

export const subredditV2 = (sub: Sub): SubredditV2 => ({
  id: sub.id, name: sub.name, nsfw: false, type: SubredditType.PUBLIC, spam: false, quarantined: false, topics: [],
  rating: SubredditRating.UNKNOWN_SUBREDDIT_RATING, subscribersCount: 1000, permalink: `/r/${sub.name}/`, title: sub.name, description: '',
});

export const postV2 = (post: Post, sub: Sub): PostV2 => {
  const urls = post.gallery.map((image) => image.url);
  return {
    id: post.id, title: post.title, selftext: '', nsfw: false, authorId: post.authorId, crowdControlLevel: CrowdControlLevel.OFF,
    numReports: post.reports.length, isGallery: post.kind === 'gallery', isMeta: false, createdAt: post.createdAt, isApproved: post.approved,
    isArchived: false, distinguished: DistinguishType.NULL_VALUE, ignoreReports: false, isSelf: post.kind === 'text', isVideo: post.kind === 'video',
    isLocked: post.locked, isSpoiler: false, subredditId: sub.id, upvotes: 1, downvotes: 0, url: post.url, isSticky: false,
    linkFlair: { text: post.flair ?? '', cssClass: '', backgroundColor: '', templateId: '', textColor: '' }, // S3: also without a flair
    spam: post.spam, deleted: post.deleted === true, languageCode: 'en', updatedAt: post.createdAt, gildings: 0, score: 1,
    numComments: 0, thumbnail: '', crosspostParentId: post.crosspostParent ?? '', permalink: permalinkOf(post), isPoll: false, isPromoted: false,
    isMultiMedia: post.kind === 'gallery' || post.kind === 'video', type: POST_TYPE[post.kind], unlisted: false,
    galleryImages: post.kind === 'gallery' ? urls : [], isImage: post.kind === 'image' || post.kind === 'gallery',
    mediaUrls: post.kind === 'image' || post.kind === 'gallery' ? urls : [], isClubContent: false, media: { type: '' },
  };
};

export const commentV2 = (comment: Comment, sub: Sub): CommentV2 => ({
  id: comment.id, parentId: comment.postId, body: comment.body, author: comment.author, numReports: 0, collapsedBecauseCrowdControl: false,
  spam: comment.spam, deleted: false, createdAt: comment.createdAt, upvotes: 1, downvotes: 0, languageCode: 'en', lastModifiedAt: comment.createdAt,
  gilded: false, score: 1, permalink: commentPermalink(comment), hasMedia: false, postId: comment.postId, subredditId: sub.id, elementTypes: [], mediaUrls: [],
});

export const postSubmit = (post: Post, author: Actor, sub: Sub): OnPostSubmitRequest => ({
  type: 'PostSubmit', post: postV2(post, sub), author: userV2(author), subreddit: subredditV2(sub),
});

/** `updater` is the user who changed the flair. */
export const postFlairUpdate = (post: Post, updater: Actor, sub: Sub): OnPostFlairUpdateRequest => ({
  type: 'PostFlairUpdate', post: postV2(post, sub), author: userV2(updater), subreddit: subredditV2(sub),
});

/** `author` is the post author; `at` the time of the deletion. */
export const postDelete = (post: Post, author: Actor, sub: Sub, source: keyof typeof EventSource & ('USER' | 'ADMIN' | 'MODERATOR'), at: number): OnPostDeleteRequest => ({
  type: 'PostDelete', postId: post.id, deletedAt: new Date(at).toISOString(), author: userV2(author), createdAt: new Date(post.createdAt).toISOString(),
  source: EventSource[source], reason: DeletionReason.UNKNOWN, subreddit: subredditV2(sub),
});

export const commentCreate = (comment: Comment, author: Actor, post: Post, sub: Sub): OnCommentCreateRequest => ({
  type: 'CommentCreate', comment: commentV2(comment, sub), author: userV2(author), post: postV2(post, sub), subreddit: subredditV2(sub),
});
