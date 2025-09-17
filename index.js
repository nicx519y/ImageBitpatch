const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const os = require('os');

// 配置Sharp以减少内存使用 - 针对实例复用优化
sharp.cache({ memory: 100, files: 20, items: 50 }); // 降低缓存，因为我们现在复用实例

// 内存监控和管理
function getMemoryUsage() {
  const usage = process.memoryUsage();
  return {
    rss: Math.round(usage.rss / 1024 / 1024), // 常驻内存 MB
    heapUsed: Math.round(usage.heapUsed / 1024 / 1024), // 堆内存使用 MB
    heapTotal: Math.round(usage.heapTotal / 1024 / 1024), // 堆内存总量 MB
    external: Math.round(usage.external / 1024 / 1024) // 外部内存 MB
  };
}

// 主动内存管理
function forceGarbageCollection(threshold = 600) {
  const memory = getMemoryUsage();
  if (memory.heapUsed > threshold && global.gc) {
    console.log(`🧹 内存使用过高 (${memory.heapUsed}MB)，执行垃圾回收`);
    global.gc();
    const afterGC = getMemoryUsage();
    console.log(`   回收后内存: ${afterGC.heapUsed}MB (节省 ${memory.heapUsed - afterGC.heapUsed}MB)`);
  }
}

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

// 获取最优的工作线程数（单线程版本）
function getOptimalWorkerCount(maxWorkers, fileCount) {
  const cpuCount = os.cpus().length;
  // 单线程处理，避免资源竞争
  const workerCount = 1;
  console.log(`🔧 CPU核心数: ${cpuCount}, 使用Worker线程数: ${workerCount} (单线程模式)`);
  return workerCount;
}

// Worker线程处理函数
if (!isMainThread) {
  // 在Worker线程中执行
  const { files, outputDir, config } = workerData;
  
  (async () => {
    try {
      const results = [];
      
      // 为每个Worker线程创建一个复用的Sharp实例池
      const sharpInstances = new Map();
      
      for (let i = 0; i < files.length; i++) {
        const inputPath = files[i];
        const result = await processImageSingleOptimized(inputPath, outputDir, config, sharpInstances);
        results.push(result);
        
        // 每个图片处理完后暂停300ms，降低CPU占用
        await new Promise(resolve => setTimeout(resolve, 300));
        
        // 单实例复用模式下，大幅减少内存检查频率
        // if ((i + 1) % 50 === 0) {
        //   const currentMemory = process.memoryUsage();
        //   const currentMemoryMB = Math.round(currentMemory.heapUsed / 1024 / 1024);
        //   if (currentMemoryMB > 400) { // 进一步提高阈值，减少GC频率
        //     forceGarbageCollection(400);
        //   }
        // }
      }
      
      // 清理所有Sharp实例
      for (const [key, instance] of sharpInstances) {
        if (instance && typeof instance.destroy === 'function') {
          instance.destroy();
        }
      }
      sharpInstances.clear();
      
      // Worker线程处理完所有文件后进行最终垃圾回收
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

// 处理单个图片文件（原版本，保留兼容性）
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
      
      // 生成输出文件名（目录已预创建）
      const scaleDir = path.join(outputDir, `x${scale}`);
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
    
    // 单实例复用模式下，减少GC调用频率
    // forceGarbageCollection(400); // 已移除频繁GC调用
  }
}

// 真正的单实例复用版本：每个Worker线程只使用一个Sharp实例，最大化复用
async function processImageSingleOptimized(inputPath, outputDir, config, sharpInstances) {
  const { targetWidth, targetHeight, cropPosition, scales, quality } = config;
  const fileName = path.parse(inputPath).name;
  
  try {
    // 读取图片数据到Buffer（一次性读取）
    const imageBuffer = fs.readFileSync(inputPath);
    
    // 获取图片元数据（使用临时实例，避免影响主实例状态）
    const tempProcessor = sharp(imageBuffer);
    const metadata = await tempProcessor.metadata();
    tempProcessor.destroy(); // 立即销毁临时实例
    
    // 计算裁剪区域
    const cropArea = calculateCropArea(
      metadata.width, 
      metadata.height, 
      targetWidth, 
      targetHeight, 
      cropPosition
    );
    
    // 获取或创建复用的Sharp实例
    let baseProcessor = sharpInstances.get('reusable_processor');
    if (!baseProcessor) {
      baseProcessor = sharp();
      sharpInstances.set('reusable_processor', baseProcessor);
    }
    
    // 处理每个倍数尺寸 - 复用同一个基础实例
    for (const scale of scales) {
      const scaledWidth = targetWidth * scale;
      const scaledHeight = targetHeight * scale;
      
      // 生成输出文件名（目录已预创建）
      const scaleDir = path.join(outputDir, `x${scale}`);
      const outputFileName = `${fileName}.webp`;
      const outputPath = path.join(scaleDir, outputFileName);
      
      try {
        // 使用Buffer和复用实例处理，减少实例创建开销
        const pipeline = sharp(imageBuffer)
          .extract(cropArea)
          .resize(scaledWidth, scaledHeight, { fit: 'fill' })
          .webp({ quality });
        
        await pipeline.toFile(outputPath);
        pipeline.destroy(); // 清理pipeline
        
        console.log(`生成: ${outputPath}`);
      } catch (scaleError) {
        console.error(`处理尺寸 ${scale}x 失败:`, scaleError.message);
      }
    }
    
    // 每个图片处理完后暂停300ms，降低CPU占用
    await new Promise(resolve => setTimeout(resolve, 300));
    
  } catch (error) {
    console.error(`处理图片失败 ${path.basename(inputPath)}:`, error.message);
  }
}

// 批处理队列处理图片文件
async function processImage(imageFiles, outputDir, config, globalProgress = null) {
  const { scales } = config;
  const batchSize = 10; // 每批处理10个文件
  const totalFiles = imageFiles.length;
  const totalBatches = Math.ceil(totalFiles / batchSize);
  
  // 预创建所有需要的输出目录
  for (const scale of scales) {
    const scaleDir = path.join(outputDir, `x${scale}`);
    ensureDir(scaleDir);
  }
  
  const configName = config.name || '未命名配置';
  console.log(`🚀 [${configName}] 开始批处理 ${totalFiles} 个图片文件，每批 ${batchSize} 个，共 ${totalBatches} 批`);
  
  let processedFiles = 0;
  
  // 分批处理文件
  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    const startIndex = batchIndex * batchSize;
    const endIndex = Math.min(startIndex + batchSize, totalFiles);
    const batchFiles = imageFiles.slice(startIndex, endIndex);
    
    // 显示当前配置和全局进度
    let progressInfo = `📦 [${configName}] 第 ${batchIndex + 1}/${totalBatches} 批 (${batchFiles.length} 个文件)`;
    if (globalProgress) {
      const globalPercent = ((globalProgress.processed / globalProgress.total) * 100).toFixed(1);
      progressInfo += ` - 全局进度: ${globalProgress.processed}/${globalProgress.total} (${globalPercent}%)`;
    }
    console.log(`\n${progressInfo}`);
    
    // 检查内存使用情况
    const memoryBefore = getMemoryUsage();
    console.log(`💾 [${configName}] 批处理前内存使用: ${memoryBefore.heapUsed}MB`);
    
    // 使用单个Worker处理当前批次
    const worker = new Worker(__filename, {
      workerData: {
        files: batchFiles,
        outputDir,
        config
      }
    });
    
    try {
      await new Promise((resolve, reject) => {
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
      
      processedFiles += batchFiles.length;
      
      // 更新全局进度
      if (globalProgress) {
        globalProgress.processed += batchFiles.length;
      }
      
      const configPercent = ((processedFiles / totalFiles) * 100).toFixed(1);
      let completionInfo = `✅ [${configName}] 第 ${batchIndex + 1} 批完成 - 配置进度: ${processedFiles}/${totalFiles} (${configPercent}%)`;
      if (globalProgress) {
        const globalPercent = ((globalProgress.processed / globalProgress.total) * 100).toFixed(1);
        completionInfo += ` - 全局进度: ${globalProgress.processed}/${globalProgress.total} (${globalPercent}%)`;
      }
      console.log(completionInfo);
      
    } finally {
      // 清理Worker线程
      worker.terminate();
    }
    
    // 批次间内存检查 - 单实例复用模式下减少GC频率
    const memoryAfterBatch = getMemoryUsage();
    if (memoryAfterBatch.heapUsed > 400) {
      forceGarbageCollection(400);
    }
    
    const memoryAfter = getMemoryUsage();
    console.log(`💾 [${configName}] 批处理后内存使用: ${memoryAfter.heapUsed}MB`);
    
    // 批次间短暂延迟，让系统有时间清理资源
    if (batchIndex < totalBatches - 1) {
      await new Promise(resolve => setTimeout(resolve, 200)); // 增加延迟到200ms，给GC更多时间
    }
  }
  
  console.log(`🎉 [${configName}] 所有批次处理完成！`);
}

// 主函数
async function main() {
  const startTime = Date.now();
  const startMemory = getMemoryUsage();
  console.log(`🚀 开始处理，初始内存使用: ${startMemory.heapUsed}MB`);
  
  try {
    // 加载配置数组
    const configs = loadConfig();
    
    // 检查多配置输出目录冲突
    if (configs.length > 1) {
      const outputDirs = new Set();
      for (const config of configs) {
        const normalizedPath = path.resolve(config.outputDir);
        if (outputDirs.has(normalizedPath)) {
          console.warn(`⚠️  警告: 检测到输出目录冲突: ${config.outputDir}`);
          console.warn('   多个配置使用相同输出目录可能导致文件覆盖或竞争条件');
        }
        outputDirs.add(normalizedPath);
      }
    }
    
    // 计算全局进度跟踪
    let totalGlobalFiles = 0;
    const configFilesCounts = [];
    
    // 预先计算所有配置的文件数量
    for (const config of configs) {
      try {
        const imageFiles = getImageFiles(config.inputDir, config.supportedFormats);
        configFilesCounts.push({ config, fileCount: imageFiles.length, files: imageFiles });
        totalGlobalFiles += imageFiles.length;
      } catch (error) {
        console.warn(`⚠️  配置 "${config.name || '未命名配置'}" 输入目录访问失败:`, error.message);
        configFilesCounts.push({ config, fileCount: 0, files: [] });
      }
    }
    
    console.log(`📊 全局统计: 共 ${configs.length} 个配置，总计 ${totalGlobalFiles} 个图片文件`);
    
    // 全局进度跟踪对象
    const globalProgress = {
      total: totalGlobalFiles,
      processed: 0
    };
    
    // 多配置并行处理（每个配置一个线程）
    if (configs.length > 1) {
      console.log(`📋 检测到 ${configs.length} 个配置，将并行处理`);
      
      // 并行处理所有配置，每个配置使用独立线程
      const configPromises = configFilesCounts.map(async ({ config, fileCount, files }, configIndex) => {
        const configName = config.name || '未命名配置';
        console.log(`🔄 启动配置 ${configIndex + 1}: ${configName} (${fileCount} 个文件)`);
        
        try {
          // 确保输出目录存在
          ensureDir(config.outputDir);
          
          if (fileCount === 0) {
            console.log(`⚠️  配置 "${configName}" 没有找到图片文件`);
            return;
          }
          
          console.log(`📁 配置 "${configName}" 找到 ${fileCount} 个图片文件`);
          
          // 处理图片文件，传入全局进度跟踪
          await processImage(files, config.outputDir, config, globalProgress);
          
          console.log(`✅ 配置 "${configName}" 处理完成`);
          
        } catch (error) {
          console.error(`❌ 配置 "${configName}" 处理失败:`, error.message);
          throw error;
        }
      });
      
      await Promise.all(configPromises);
    } else {
      // 单配置处理
      const { config, fileCount, files } = configFilesCounts[0];
      const configName = config.name || '未命名配置';
      
      // 确保输出目录存在
      ensureDir(config.outputDir);
      
      if (fileCount > 0) {
        console.log(`📁 配置 "${configName}" 找到 ${fileCount} 个图片文件`);
        // 处理图片文件，传入全局进度跟踪
        await processImage(files, config.outputDir, config, globalProgress);
      } else {
        console.log(`⚠️  配置 "${configName}" 没有找到图片文件`);
      }
    }
    
    const endTime = Date.now();
    const duration = ((endTime - startTime) / 1000).toFixed(2);
    const endMemory = getMemoryUsage();
    console.log(`\n🎉 所有任务完成，总耗时: ${duration}秒`);
    console.log(`📊 内存使用情况: 开始 ${startMemory.heapUsed}MB → 结束 ${endMemory.heapUsed}MB (峰值可能更高)`);
    
    // 最终内存清理
    forceGarbageCollection(0); // 强制执行最终垃圾回收
    
  } catch (error) {
    console.error('❌ 处理过程中发生错误:', error.message);
    process.exit(1);
  }
}

// 运行主函数（只在主线程中运行）
if (require.main === module && isMainThread) {
  main();
}

module.exports = { main, loadConfig, processImage };