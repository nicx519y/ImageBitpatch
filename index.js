const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const os = require('os');

// 默认配置
const defaultConfig = {
  inputDir: './input',           // 输入目录
  outputDir: './output',         // 输出目录
  targetWidth: 800,              // 目标宽度
  targetHeight: 600,             // 目标高度
  cropPosition: 'center',        // 裁剪位置: 'top', 'center', 'bottom'
  scales: [1, 2, 3],            // 导出的倍数尺寸
  quality: 80,                   // WebP压缩品质 (0-100)
  maxWorkers: 4,                 // 最大工作线程数
  supportedFormats: ['.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.gif', '.webp']
};

// 读取配置文件
function loadConfig() {
  const configPath = path.join(__dirname, 'config.json');
  if (fs.existsSync(configPath)) {
    try {
      const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      
      // 如果是新的配置数组格式
      if (configData.configs && Array.isArray(configData.configs)) {
        return configData.configs.map(config => ({ ...defaultConfig, ...config }));
      }
      
      // 兼容旧的单一配置格式
      return [{ ...defaultConfig, ...configData }];
    } catch (error) {
      console.warn('配置文件读取失败，使用默认配置:', error.message);
    }
  }
  return [defaultConfig];
}

// 确保目录存在
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
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

// 将文件数组分组，用于多线程处理
function chunkArray(array, chunkSize) {
  const chunks = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
}

// 获取最优的工作线程数
function getOptimalWorkerCount(maxWorkers, fileCount) {
  const cpuCount = os.cpus().length;
  const maxRecommended = Math.min(cpuCount, maxWorkers);
  return Math.min(maxRecommended, fileCount);
}

// Worker线程处理函数
if (!isMainThread) {
  // 在Worker线程中执行
  const { files, outputDir, config } = workerData;
  
  (async () => {
    try {
      const results = [];
      for (const inputPath of files) {
        const result = await processImageSingle(inputPath, outputDir, config);
        results.push(result);
      }
      
      // Worker线程处理完所有文件后进行垃圾回收
      if (global.gc) {
        global.gc();
      }
      
      parentPort.postMessage({ success: true, results });
    } catch (error) {
      parentPort.postMessage({ success: false, error: error.message });
    }
  })();
}

// 计算裁剪区域
function calculateCropArea(originalWidth, originalHeight, targetWidth, targetHeight, cropPosition) {
  // 计算目标宽高比
  const targetRatio = targetWidth / targetHeight;
  const originalRatio = originalWidth / originalHeight;
  
  let cropWidth, cropHeight, left, top;
  
  if (originalRatio > targetRatio) {
    // 原图更宽，需要裁剪宽度
    cropHeight = originalHeight;
    cropWidth = Math.round(originalHeight * targetRatio);
    left = Math.round((originalWidth - cropWidth) / 2); // 水平居中
    top = 0;
  } else {
    // 原图更高，需要裁剪高度
    cropWidth = originalWidth;
    cropHeight = Math.round(originalWidth / targetRatio);
    left = 0;
    
    // 根据裁剪位置计算垂直偏移
    switch (cropPosition) {
      case 'top':
        top = 0;
        break;
      case 'bottom':
        top = originalHeight - cropHeight;
        break;
      case 'center':
      default:
        top = Math.round((originalHeight - cropHeight) / 2);
        break;
    }
  }
  
  return {
    left: Math.max(0, left),
    top: Math.max(0, top),
    width: Math.min(cropWidth, originalWidth),
    height: Math.min(cropHeight, originalHeight)
  };
}

// 处理单个图片文件
async function processImageSingle(inputPath, outputDir, config) {
  const { targetWidth, targetHeight, cropPosition, scales, quality } = config;
  const fileName = path.parse(inputPath).name;
  
  let image = null;
  
  try {
    // 获取原图信息
    image = sharp(inputPath);
    const metadata = await image.metadata();
    
    // 计算裁剪区域
    const cropArea = calculateCropArea(
      metadata.width, 
      metadata.height, 
      targetWidth, 
      targetHeight, 
      cropPosition
    );
    
    // 处理每个倍数尺寸
    for (const scale of scales) {
      const scaledWidth = targetWidth * scale;
      const scaledHeight = targetHeight * scale;
      
      // 创建对应倍数的子目录
      const scaleDir = path.join(outputDir, `x${scale}`);
      ensureDir(scaleDir);
      
      // 生成输出文件名
      const outputFileName = `${fileName}.webp`;
      const outputPath = path.join(scaleDir, outputFileName);
      
      // 为每个尺寸创建新的sharp实例，避免内存累积
      const processor = sharp(inputPath)
        .extract(cropArea)  // 先裁剪
        .resize(scaledWidth, scaledHeight, {
          fit: 'fill'  // 填充到目标尺寸
        })
        .webp({ quality });
      
      await processor.toFile(outputPath);
      
      // 显式销毁处理器实例
      processor.destroy();
      
      console.log(`生成: ${outputPath}`);
    }
  } catch (error) {
    console.error(`处理图片失败 ${path.basename(inputPath)}:`, error.message);
  } finally {
    // 清理资源
    if (image) {
      image.destroy();
    }
    
    // 强制垃圾回收（如果可用）
    if (global.gc) {
      global.gc();
    }
  }
}

// 多线程处理图片文件
async function processImage(imageFiles, outputDir, config) {
  const { maxWorkers } = config;
  const workerCount = getOptimalWorkerCount(maxWorkers, imageFiles.length);
  
  if (workerCount === 1 || imageFiles.length === 1) {
    // 单线程处理
    for (let i = 0; i < imageFiles.length; i++) {
      const inputPath = imageFiles[i];
      await processImageSingle(inputPath, outputDir, config);
    }
    return;
  }
  
  // 将文件分组
  const filesPerWorker = Math.ceil(imageFiles.length / workerCount);
  const fileChunks = chunkArray(imageFiles, filesPerWorker);
  
  // 创建Worker线程池
  const workers = [];
  const promises = [];
  
  for (let i = 0; i < fileChunks.length; i++) {
    const chunk = fileChunks[i];
    if (chunk.length === 0) continue;
    
    const worker = new Worker(__filename, {
      workerData: {
        files: chunk,
        outputDir,
        config
      }
    });
    
    workers.push(worker);
    
    const promise = new Promise((resolve, reject) => {
      worker.on('message', (result) => {
        if (result.success) {
          resolve(result.results);
        } else {
          reject(new Error(result.error));
        }
      });
      
      worker.on('error', reject);
      worker.on('exit', (code) => {
        if (code !== 0) {
          reject(new Error(`Worker线程异常退出，代码: ${code}`));
        }
      });
    });
    
    promises.push(promise);
  }
  
  try {
    // 等待所有Worker线程完成
    await Promise.all(promises);
  } catch (error) {
    console.error('多线程处理出错:', error.message);
    throw error;
  } finally {
    // 清理Worker线程
    workers.forEach(worker => worker.terminate());
  }
}

// 主函数
async function main() {
  const startTime = Date.now();
  
  try {
    // 加载配置数组
    const configs = loadConfig();
    
    // 多配置并发处理
    if (configs.length > 1) {
      // 并行处理所有配置
      const configPromises = configs.map(async (config, configIndex) => {
        
        try {
          // 确保输出目录存在
          ensureDir(config.outputDir);
          
          // 获取所有图片文件
          const imageFiles = getImageFiles(config.inputDir, config.supportedFormats);
          
          if (imageFiles.length === 0) {
            return;
          }
          
          // 多线程处理图片文件
          await processImage(imageFiles, config.outputDir, config);
        } catch (error) {
          console.error(`❌ 配置 "${config.name || '未命名配置'}" 处理失败:`, error.message);
          throw error;
        }
      });
      
      await Promise.all(configPromises);
    } else {
      // 单配置处理
      const config = configs[0];
      
      // 确保输出目录存在
      ensureDir(config.outputDir);
      
      // 获取所有图片文件
      const imageFiles = getImageFiles(config.inputDir, config.supportedFormats);
      
      if (imageFiles.length > 0) {
        // 多线程处理图片文件
        await processImage(imageFiles, config.outputDir, config);
      }
    }
    
    const endTime = Date.now();
    const duration = ((endTime - startTime) / 1000).toFixed(2);
    console.log(`\n🎉 所有任务完成，总耗时: ${duration}秒`);
    
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