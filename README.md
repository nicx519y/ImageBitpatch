# 图片批处理工具

一个基于 Node.js 的图片批处理脚本，支持图片等比缩放、多倍尺寸导出和 WebP 格式压缩。

## 功能特性

- ✅ 可配置输入和输出目录
- ✅ 按指定宽度等比缩放图片
- ✅ 同时导出多个倍数尺寸（如 1x, 2x, 3x）
- ✅ 可配置压缩品质
- ✅ 自动转换为 WebP 格式
- ✅ 支持多种输入格式（JPG, PNG, BMP, TIFF, GIF）

## 安装依赖

```bash
npm install
```

## 使用方法

### 1. 准备图片文件

在项目根目录创建 `input` 文件夹，将需要处理的图片放入其中。

### 2. 配置参数（可选）

编辑 `config.json` 文件来自定义处理参数：

```json
{
  "inputDir": "./input",           // 输入目录路径
  "outputDir": "./output",         // 输出目录路径
  "targetWidth": 800,              // 目标宽度（像素）
  "scales": [1, 2, 3],            // 导出的倍数尺寸
  "quality": 80,                   // WebP 压缩品质 (0-100)
  "supportedFormats": [            // 支持的输入格式
    ".jpg", ".jpeg", ".png", ".bmp", ".tiff", ".gif"
  ]
}
```

### 3. 运行脚本

```bash
npm start
```

或者直接运行：

```bash
node index.js
```

## 配置参数说明

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `inputDir` | string | `"./input"` | 输入图片目录路径 |
| `outputDir` | string | `"./output"` | 输出图片目录路径 |
| `targetWidth` | number | `800` | 目标宽度（像素），图片会等比缩放到此宽度 |
| `scales` | array | `[1, 2, 3]` | 导出的倍数尺寸，会生成对应倍数的图片 |
| `quality` | number | `80` | WebP 压缩品质，范围 0-100，数值越高品质越好 |
| `supportedFormats` | array | `[".jpg", ".jpeg", ".png", ".bmp", ".tiff", ".gif"]` | 支持的输入图片格式 |

## 输出文件命名规则

- 1x 尺寸：`原文件名.webp`
- 2x 尺寸：`原文件名@x2.webp`
- 3x 尺寸：`原文件名@x3.webp`
- 以此类推...

## 示例

假设有一张名为 `photo.jpg` 的图片，配置为：
- 目标宽度：800px
- 倍数尺寸：[1, 2, 3]
- 压缩品质：80

处理后会生成：
- `photo.webp` (800px 宽)
- `photo@x2.webp` (1600px 宽)
- `photo@x3.webp` (2400px 宽)

## 注意事项

1. 确保输入目录存在且包含支持的图片格式
2. 输出目录会自动创建（如果不存在）
3. 所有图片都会转换为 WebP 格式
4. 图片会保持原始宽高比进行等比缩放
5. 如果原图宽度小于目标宽度，图片会被放大

## 依赖库

- [Sharp](https://sharp.pixelplumbing.com/) - 高性能图片处理库