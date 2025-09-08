const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

// 默认配置
const defaultConfig = {
  inputDir: './input',           // 输入目录
  outputDir: './output',         // 输出目录
  targetWidth: 800,              // 目标宽度
  scales: [1, 2, 3],            // 导出的倍数尺寸
  quality: 80,                   // WebP压缩品质 (0-100)
  supportedFormats: ['.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.gif']
};

// 读取配置文件
function loadConfig() {
  const configPath = path.join(__dirname, 'config.json');
  if (fs.existsSync(configPath)) {
    try {
      const userConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return { ...defaultConfig, ...userConfig };
    } catch (error) {
      console.warn('配置文件读取失败，使用默认配置:', error.message);
    }
  }
  return defaultConfig;
}

// 确保目录存在
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    console.log(`创建目录: ${dirPath}`);
  }
}

// 获取目录中的所有图片文件
function getImageFiles(inputDir, supportedFormats) {
  if (!fs.existsSync(inputDir)) {
    throw new Error(`输入目录不存在: ${inputDir}`);
  }

  const files = fs.readdirSync(inputDir);
  return files.filter(file => {
    const ext = path.extname(file).toLowerCase();
    return supportedFormats.includes(ext);
  }).map(file => path.join(inputDir, file));
}

// 处理单个图片文件
async function processImage(inputPath, outputDir, config) {
  const { targetWidth, scales, quality } = config;
  const fileName = path.parse(inputPath).name;
  
  console.log(`处理图片: ${path.basename(inputPath)}`);
  
  try {
    // 获取原图信息
    const image = sharp(inputPath);
    const metadata = await image.metadata();
    
    // 计算目标高度（等比缩放）
    const aspectRatio = metadata.height / metadata.width;
    const targetHeight = Math.round(targetWidth * aspectRatio);
    
    // 处理每个倍数尺寸
    for (const scale of scales) {
      const scaledWidth = targetWidth * scale;
      const scaledHeight = targetHeight * scale;
      
      // 生成输出文件名
      const suffix = scale === 1 ? '' : `@x${scale}`;
      const outputFileName = `${fileName}${suffix}.webp`;
      const outputPath = path.join(outputDir, outputFileName);
      
      // 处理并保存图片
      await sharp(inputPath)
        .resize(scaledWidth, scaledHeight, {
          fit: 'inside',
          withoutEnlargement: false
        })
        .webp({ quality })
        .toFile(outputPath);
      
      console.log(`  生成: ${outputFileName} (${scaledWidth}x${scaledHeight})`);
    }
  } catch (error) {
    console.error(`处理图片失败 ${path.basename(inputPath)}:`, error.message);
  }
}

// 主函数
async function main() {
  console.log('=== 图片批处理工具 ===\n');
  
  try {
    // 加载配置
    const config = loadConfig();
    console.log('配置信息:');
    console.log(`  输入目录: ${config.inputDir}`);
    console.log(`  输出目录: ${config.outputDir}`);
    console.log(`  目标宽度: ${config.targetWidth}px`);
    console.log(`  导出倍数: ${config.scales.join(', ')}`);
    console.log(`  压缩品质: ${config.quality}`);
    console.log('');
    
    // 确保输出目录存在
    ensureDir(config.outputDir);
    
    // 获取所有图片文件
    const imageFiles = getImageFiles(config.inputDir, config.supportedFormats);
    
    if (imageFiles.length === 0) {
      console.log(`在目录 ${config.inputDir} 中未找到支持的图片文件`);
      console.log(`支持的格式: ${config.supportedFormats.join(', ')}`);
      return;
    }
    
    console.log(`找到 ${imageFiles.length} 个图片文件\n`);
    
    // 处理每个图片文件
    for (let i = 0; i < imageFiles.length; i++) {
      const inputPath = imageFiles[i];
      console.log(`[${i + 1}/${imageFiles.length}]`);
      await processImage(inputPath, config.outputDir, config);
      console.log('');
    }
    
    console.log('✅ 所有图片处理完成！');
    
  } catch (error) {
    console.error('❌ 处理过程中发生错误:', error.message);
    process.exit(1);
  }
}

// 运行主函数
if (require.main === module) {
  main();
}

module.exports = { main, loadConfig, processImage };