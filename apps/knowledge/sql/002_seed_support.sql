-- 初始化固定管理员；仅保存随机盐 scrypt 哈希。重复执行不覆盖现有密码。
INSERT INTO public.knowledge_users(id,username,password_hash)
VALUES('2f788583-7dea-4bda-91ae-e56c83f66d1d','support','scrypt:32768:8:3:534db39ea29f8395e58c0cab4256dc2d:cd41781fc1db0bdc20d148b662178fe79a45c84f03a4ff42275e787a097e6cea')
ON CONFLICT(username) DO NOTHING;
