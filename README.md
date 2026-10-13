# HeartBeatAlbum 💗

心动纪念册 HeartBeatAlbum —— 大二上纪念我的女朋友的美好时光所做相册，随手而为，如果有人喜欢可能会更新。

To memorize the sweet time with my girlfriend, I made this album in my second year in college, just for fun. If someone likes it, maybe I will update. :)

## 运行

```bash
npm install
npm start
```

Windows 用户也可以直接双击 `启动心动纪念册.bat`。

## 操作

| 操作 | 效果 |
| --- | --- |
| 点击长方形 | 空格子 → 选照片、写句话；有照片 → 看大图，文字逐字跳出 |
| 滚轮 | 以鼠标位置为焦点缩放画面 |
| 按住拖动 | 平移整个画面 |
| 鼠标悬停 | 长方形高亮描边，照片浮起放大预览 |
| Esc | 关闭弹层 |
| 右上角 ⚙ | 设置面板：模糊度、透明度、方块大小、图片库、背景音乐 |

更多的玩法，留给你自己探索 ✨

## 照片与备份

数据保存在系统用户目录，不在项目文件夹里，程序删了数据也在：

```
%APPDATA%\heartbeat-album\album-data\
├── photos/     相册照片
├── pictures/   图片库（往里丢图就能选）
└── music/      背景音乐
```

备份 = 复制整个 `album-data` 文件夹。

## License

MIT
