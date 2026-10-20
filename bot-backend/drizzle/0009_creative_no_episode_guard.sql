-- 创意/影片项目禁用剧集（SQLite 时代的 RAISE 触发器在 pg 化时丢失——行为回归修复）
CREATE OR REPLACE FUNCTION drama_no_episode_guard() RETURNS trigger AS $$
BEGIN
  IF (SELECT project_type FROM dramas WHERE id = NEW.drama_id) IN ('creative', 'film') THEN
    RAISE EXCEPTION '创意视频项目不使用剧集';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS creative_no_episode_insert ON episodes;
CREATE TRIGGER creative_no_episode_insert
  BEFORE INSERT OR UPDATE OF drama_id ON episodes
  FOR EACH ROW EXECUTE FUNCTION drama_no_episode_guard();
