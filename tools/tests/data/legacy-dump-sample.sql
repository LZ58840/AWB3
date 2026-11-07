-- Synthetic sample in the shape of `mysqldump awb subreddits submissions images` (MySQL 8.0.29). IDs and names are made up.
-- Newest post: 1795608000 = 2026-11-25T12:00:00Z. Six months before: 1779710400 (1ok0edg is exactly on it, 1ok0edf is 1 s older).
-- MySQL dump 10.13  Distrib 8.0.29, for Linux (x86_64)
--
-- Host: localhost    Database: awb
-- ------------------------------------------------------
-- Server version	8.0.29

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!50503 SET NAMES utf8mb4 */;

--
-- Table structure for table `subreddits`
--

DROP TABLE IF EXISTS `subreddits`;
CREATE TABLE `subreddits` (
  `name` varchar(20) NOT NULL,
  `settings` json DEFAULT NULL,
  `latest_utc` int DEFAULT NULL,
  `revision_utc` int DEFAULT NULL,
  PRIMARY KEY (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

LOCK TABLES `subreddits` WRITE;
INSERT INTO `subreddits` VALUES ('AnimePhoneWallpapers','{\"enabled\": true, \"flairs\": {}}',1795600000,1795000000),('Animewallpaper','{\"enabled\": true, \"flairs\": {\"Other\": \"skip\"}}',1795608000,1795000000);
UNLOCK TABLES;

--
-- Table structure for table `submissions`
--

DROP TABLE IF EXISTS `submissions`;
CREATE TABLE `submissions` (
  `id` varchar(20) NOT NULL,
  `subreddit` varchar(20) NOT NULL,
  `author` varchar(20) NOT NULL,
  `created_utc` int NOT NULL,
  `removed` tinyint(1) NOT NULL DEFAULT '0',
  `deleted` tinyint(1) NOT NULL DEFAULT '0',
  `approved` tinyint(1) NOT NULL DEFAULT '0',
  `moderated` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  KEY `subreddit` (`subreddit`),
  CONSTRAINT `submissions_ibfk_1` FOREIGN KEY (`subreddit`) REFERENCES `subreddits` (`name`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

LOCK TABLES `submissions` WRITE;
/*!40000 ALTER TABLE `submissions` DISABLE KEYS */;
INSERT INTO `submissions` VALUES ('1ofx9ld','Animewallpaper','user_a',1770000000,0,0,0,1),('1ojh3zn','AnimePhoneWallpapers','user_b',1779000000,0,0,0,1),('1ok0edf','Animewallpaper','user_c',1779710399,0,0,0,1),('1ok0edg','Animewallpaper','user_d',1779710400,1,0,0,1),('1on8d3f','Animewallpaper','user_a',1780000000,0,1,0,1),('1p1c5qe','Animewallpaper','user_e',1785000000,0,0,1,1),('1q2m7ts','Animewallpaper','user_b',1793000000,0,0,0,1),('1q4t6rw','AnimePhoneWallpapers','user_f',1794000000,0,0,0,1),('1q8k9vd','Animewallpaper','user_c',1795570000,0,0,0,1),('1q8w2pq','AnimePhoneWallpapers','user_g',1795600000,0,0,0,0),('1q8x1ab','Animewallpaper','user_d',1795601200,0,0,0,0),('1q8z4mc','Animewallpaper','user_e',1795608000,0,0,0,0);
/*!40000 ALTER TABLE `submissions` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `images`
--

DROP TABLE IF EXISTS `images`;
CREATE TABLE `images` (
  `id` int NOT NULL AUTO_INCREMENT,
  `submission_id` varchar(20) NOT NULL,
  `url` varchar(255) NOT NULL,
  `width` int NOT NULL,
  `height` int NOT NULL,
  `sift` longblob,
  PRIMARY KEY (`id`),
  UNIQUE KEY `submission_id` (`submission_id`,`url`),
  CONSTRAINT `images_ibfk_1` FOREIGN KEY (`submission_id`) REFERENCES `submissions` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=3 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

LOCK TABLES `images` WRITE;
INSERT INTO `images` VALUES (1,'1q8z4mc','https://i.redd.it/aaaaaaaaaaaaa.jpeg',3840,2160,0x80049512000000),(2,'1q8x1ab','https://i.redd.it/bbbbbbbbbbbbb.png',1920,1080,NULL);
UNLOCK TABLES;
-- Dump completed on 2026-11-25 12:01:30
