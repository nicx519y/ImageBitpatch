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

// 获取最优的工作线程数
function getOptimalWorkerCount(maxWorkers, fileCount) {
  const cpuCount = os.cpus().length;
  // 根据CPU核心数、配置的最大线程数和文件数量确定最优线程数
  const optimalCount = Math.min(maxWorkers, cpuCount, fileCount);
  console.log(`🔧 CPU核心数: ${cpuCount}, 配置最大线程: ${maxWorkers}, 文件数: ${fileCount}, 使用线程数: ${optimalCount}`);
  return optimalCount;
}

// Worker线程处理函数
if (!isMainThread) {
  // 在Worker线程中执行
  const { files, outputDir, config, workerId, scaleName } = workerData;
  
  (async () => {
    try {
      const results = [];
      const workerName = workerId ? `Worker-${workerId}` : 'Worker';
      const scaleInfo = scaleName ? ` (${scaleName})` : '';
      
      console.log(`🔄 [${config.name || '未命名配置'}] ${workerName}${scaleInfo} 开始处理 ${files.length} 个图片文件`);
      
      // 为每个Worker线程创建独立的Sharp实例池
      // 每个Worker使用唯一的实例标识，避免实例冲突
      const sharpInstances = new Map();
      
      // 记录开始时间和内存
      const startTime = Date.now();
      const startMemory = getMemoryUsage();
      
      // 处理分配给该Worker的图片文件
      for (let i = 0; i < files.length; i++) {
        const inputPath = files[i];
        const fileName = path.basename(inputPath);
        
        console.log(`📷 [${config.name || '未命名配置'}] ${workerName}${scaleInfo} 处理: ${fileName} (${i + 1}/${files.length})`);
        
        const result = await processImageSingleOptimized(inputPath, outputDir, config, sharpInstances);
        results.push(result);
        
        // 每个图片处理完后暂停20ms，降低CPU占用
        await new Promise(resolve => setTimeout(resolve, 20));
        
        // 定期内存检查（每5个文件检查一次，分组处理频率可以更高）
        if ((i + 1) % 5 === 0) {
          const currentMemory = getMemoryUsage();
          if (currentMemory.heapUsed > 250) { // 分组Worker内存阈值设置更低
            console.log(`🧹 [${config.name || '未命名配置'}] ${workerName}${scaleInfo} 内存清理: ${currentMemory.heapUsed}MB`);
            if (global.gc) {
              global.gc();
            }
          }
        }
      }
      
      // 清理所有Sharp实例
      console.log(`🧹 [${config.name || '未命名配置'}] ${workerName}${scaleInfo} 清理Sharp实例: ${sharpInstances.size} 个`);
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
      
      // 统计处理结果
      const endTime = Date.now();
      const duration = ((endTime - startTime) / 1000).toFixed(2);
      const endMemory = getMemoryUsage();
      const totalGeneratedFiles = results.reduce((sum, result) => sum + result.generatedFiles, 0);
      
      console.log(`✅ [${config.name || '未命名配置'}] ${workerName}${scaleInfo} 完成: ${files.length} 图片 → ${totalGeneratedFiles} 文件，耗时 ${duration}s`);
      console.log(`📊 [${config.name || '未命名配置'}] ${workerName}${scaleInfo} 内存: ${startMemory.heapUsed}MB → ${endMemory.heapUsed}MB`);
      
      parentPort.postMessage({ success: true, results });
    } catch (error) {
      const workerName = workerId ? `Worker-${workerId}` : 'Worker';
      const scaleInfo = scaleName ? ` (${scaleName})` : '';
      console.error(`❌ [${config.name || '未命名配置'}] ${workerName}${scaleInfo} 处理失败:`, error.message);
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

// 单倍数处理版本：每个Worker线程只处理一个特定倍数
async function processImageSingleOptimized(inputPath, outputDir, config, sharpInstances) {
  const { targetWidth, targetHeight, cropPosition, scales, quality } = config;
  const fileName = path.parse(inputPath).name;
  
  // 现在每个Worker只处理一个倍数，scales数组应该只有一个元素
  const scale = scales[0];
  if (!scale) {
    console.error(`处理图片失败 ${path.basename(inputPath)}: 未找到倍数配置`);
    return { file: inputPath, success: false, error: '未找到倍数配置', generatedFiles: 0 };
  }
  
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
    
    // 处理单个倍数尺寸
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
      
      // 每个图片处理完后暂停300ms，降低CPU占用
      await new Promise(resolve => setTimeout(resolve, 300));
      
      return { file: inputPath, success: true, generatedFiles: 1 };
      
    } catch (scaleError) {
      console.error(`处理尺寸 ${scale}x 失败:`, scaleError.message);
      return { file: inputPath, success: false, error: scaleError.message, generatedFiles: 0 };
    }
    
  } catch (error) {
    console.error(`处理图片失败 ${path.basename(inputPath)}:`, error.message);
    return { file: inputPath, success: false, error: error.message, generatedFiles: 0 };
  }
}

// 批处理队列处理图片文件
async function processImage(imageFiles, outputDir, config, globalProgress = null) {
  const { scales, threadsPerScale = 1 } = config;
  const totalFiles = imageFiles.length;
  
  // 计算总输出文件数（每个图片 × 尺寸数）
  const totalOutputFiles = totalFiles * scales.length;
  
  // 预创建所有需要的输出目录
  for (const scale of scales) {
    const scaleDir = path.join(outputDir, `x${scale}`);
    ensureDir(scaleDir);
  }
  
  const configName = config.name || '未命名配置';
  
  console.log(`🚀 [${configName}] 开始倍数内分组多线程处理 ${totalFiles} 个图片文件`);
  console.log(`📊 [${configName}] 总输出文件数: ${totalOutputFiles} (${totalFiles} 图片 × ${scales.length} 尺寸)`);
  console.log(`🔧 [${configName}] 每个倍数使用 ${threadsPerScale} 个Worker线程`);
  
  // 为每个倍数创建多个Worker线程（按文件分组）
  const allWorkerGroups = [];
  let globalWorkerId = 1;
  
  for (const scale of scales) {
    // 将文件分组给该倍数的多个Worker线程
    const fileGroups = [];
    
    // 初始化分组
    for (let i = 0; i < threadsPerScale; i++) {
      fileGroups.push([]);
    }
    
    // 轮询分配文件到各个分组
    for (let i = 0; i < totalFiles; i++) {
      const groupIndex = i % threadsPerScale;
      fileGroups[groupIndex].push(imageFiles[i]);
    }
    
    // 为该倍数的每个文件分组创建Worker配置
    for (let groupIndex = 0; groupIndex < threadsPerScale; groupIndex++) {
      const files = fileGroups[groupIndex];
      if (files.length > 0) { // 只创建有文件的分组
        allWorkerGroups.push({
          workerId: globalWorkerId++,
          scale: scale,
          scaleName: `x${scale}`,
          groupIndex: groupIndex + 1,
          files: files,
          expectedOutputs: files.length
        });
      }
    }
  }
  
  const totalWorkers = allWorkerGroups.length;
  console.log(`📦 [${configName}] 文件分组完成: ${scales.length} 个倍数 × ${threadsPerScale} 线程 = ${totalWorkers} 个Worker线程`);
  
  // 按倍数分组显示线程信息
  for (const scale of scales) {
    const scaleWorkers = allWorkerGroups.filter(group => group.scale === scale);
    console.log(`   倍数 x${scale}: ${scaleWorkers.length} 个线程`);
    scaleWorkers.forEach((group) => {
      console.log(`     Worker ${group.workerId} (x${scale}-${group.groupIndex}): ${group.files.length} 个图片 → ${group.expectedOutputs} 个输出文件`);
    });
  }
  
  // 检查初始内存使用情况
  const memoryBefore = getMemoryUsage();
  console.log(`💾 [${configName}] 多线程处理前内存使用: ${memoryBefore.heapUsed}MB`);
  
  // 创建所有Worker线程并并行处理
  const workerPromises = allWorkerGroups.map(async (group) => {
    const worker = new Worker(__filename, {
      workerData: {
        files: group.files,
        outputDir,
        config: {
          ...config,
          scales: [group.scale] // 每个Worker只处理一个倍数
        },
        workerId: group.workerId,
        scaleName: `${group.scaleName}-${group.groupIndex}`
      }
    });
    
    try {
      const results = await new Promise((resolve, reject) => {
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
            reject(new Error(`Worker线程 ${group.workerId} (${group.scaleName}-${group.groupIndex}) 异常退出，代码: ${code}`));
          }
        });
      });
      
      // 更新全局进度（按文件分组计算）
      if (globalProgress) {
        globalProgress.processed += group.files.length;
        const globalPercent = ((globalProgress.processed / globalProgress.total) * 100).toFixed(1);
        console.log(`✅ [${configName}] Worker ${group.workerId} (${group.scaleName}-${group.groupIndex}) 完成 ${group.files.length} 个图片 - 全局进度: ${globalProgress.processed}/${globalProgress.total} (${globalPercent}%)`);
      } else {
        console.log(`✅ [${configName}] Worker ${group.workerId} (${group.scaleName}-${group.groupIndex}) 完成 ${group.files.length} 个图片`);
      }
      
      return { scale: group.scale, groupIndex: group.groupIndex, results };
      
    } finally {
      // 清理Worker线程
      worker.terminate();
    }
  });
  
  // 等待所有Worker线程完成
  const allResults = await Promise.all(workerPromises);
  
  // 统计处理结果
  const totalProcessedFiles = allResults.reduce((sum, groupResult) => {
    return sum + groupResult.results.length;
  }, 0);
  const totalGeneratedFiles = allResults.reduce((sum, groupResult) => {
    return sum + groupResult.results.reduce((fileSum, result) => fileSum + result.generatedFiles, 0);
  }, 0);
  
  const memoryAfter = getMemoryUsage();
  console.log(`💾 [${configName}] 多线程处理后内存使用: ${memoryAfter.heapUsed}MB`);
  
  console.log(`🎉 [${configName}] 倍数内分组多线程处理完成！`);
  console.log(`📊 [${configName}] 处理统计: ${totalWorkers} 个Worker线程处理 ${totalProcessedFiles} 个任务 → ${totalGeneratedFiles} 个输出文件`);
  
  // 处理完成后进行内存清理
  if (memoryAfter.heapUsed > 400) {
    forceGarbageCollection(400);
  }
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
    
    // 计算全局进度跟踪（按倍数内线程分组计算）
    let totalGlobalFiles = 0;
    let totalProcessingUnits = 0;
    const configFilesCounts = [];
    
    // 预先计算所有配置的文件数量
    for (const config of configs) {
      try {
        const imageFiles = getImageFiles(config.inputDir, config.supportedFormats);
        const threadsPerScale = config.threadsPerScale || 1;
        
        configFilesCounts.push({ config, fileCount: imageFiles.length, files: imageFiles });
        totalGlobalFiles += imageFiles.length;
        
        // 每个线程处理的文件数作为处理单位
        for (const scale of config.scales) {
          // 计算每个倍数下各线程的文件分配
          for (let threadIndex = 0; threadIndex < threadsPerScale; threadIndex++) {
            const filesForThisThread = Math.ceil(imageFiles.length / threadsPerScale);
            const actualFiles = Math.min(filesForThisThread, Math.max(0, imageFiles.length - threadIndex * filesForThisThread));
            if (actualFiles > 0) {
              totalProcessingUnits += actualFiles;
            }
          }
        }
      } catch (error) {
        console.warn(`⚠️  配置 "${config.name || '未命名配置'}" 输入目录访问失败:`, error.message);
        configFilesCounts.push({ config, fileCount: 0, files: [] });
      }
    }
    
    console.log(`📊 全局统计: 共 ${configs.length} 个配置，总计 ${totalGlobalFiles} 个图片文件，${totalProcessingUnits} 个处理单位`);
    
    // 全局进度跟踪对象
    const globalProgress = {
      total: totalProcessingUnits,
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