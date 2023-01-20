import { Stats } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { optimize as svgo } from 'svgo';
import { minify as htmlminifier } from 'html-minifier-terser';
import { minify as csso } from 'csso';
import { transform as lightcss } from 'lightningcss';
import { formatBytes } from './utils.js';
import sharp from 'sharp';
import swc from '@swc/core';
import $state, { ReportItem } from './state.js';
import { globby } from 'globby';
import config, { WebpOptions } from './config.js';
import type { Image, ImageFormat } from './types.js';
import ora from 'ora';
import {
  getFromCacheCompressImage,
  addToCacheCompressImage,
  computeCacheHash,
} from './cache.js';

async function compressJS(code: string): Promise<string> {
  const newjsresult = await swc.minify(code, { compress: true, mangle: true });
  return newjsresult.code;
}

async function compressInlineJS(code: string): Promise<string> {
  const newCode = await compressJS(code);
  if (newCode && newCode.length < code.length) return newCode;
  return code;
}

const processFile = async (file: string, stats: Stats): Promise<void> => {
  let writeData: Buffer | string | undefined = undefined;

  try {
    const ext = path.extname(file);

    switch (ext) {
      case '.png':
      case '.jpg':
      case '.jpeg':
      case '.svg':
      case '.webp':
      case '.avif':
        const newImage = await compressImageFile(file);
        if (newImage?.data && newImage.data.length < stats.size) {
          writeData = newImage.data;
        }
        break;
      case '.html':
      case '.htm':
        const htmldata = await fs.readFile(file);
        const newhtmlData = await htmlminifier(htmldata.toString(), {
          minifyCSS: true,
          minifyJS: compressInlineJS,
          sortClassName: true,
          sortAttributes: true,
        });
        writeData = newhtmlData;
        break;
      case '.css':
        const cssdata = await fs.readFile(file);

        // Compress with csso
        const cssoCSSData = await csso(cssdata.toString(), { comments: false })
          .css;

        // Compress with lightningcss
        const lightCSSData = lightcss({
          filename: 'style.css',
          code: cssdata,
          minify: true,
          sourceMap: false,
        }).code;

        // Pick the best
        if (cssoCSSData && lightCSSData) {
          writeData =
            cssoCSSData.length <= lightCSSData.length
              ? cssoCSSData
              : lightCSSData;
        } else if (cssoCSSData && !lightCSSData) {
          writeData = cssoCSSData;
        } else if (!cssoCSSData && lightCSSData) {
          writeData = lightCSSData;
        }
        break;
      case '.js':
        const jsdata = await fs.readFile(file);
        const newJS = await compressJS(jsdata.toString());
        if (newJS && newJS.length < jsdata.length) {
          writeData = newJS;
        }
        break;
    }
  } catch (e) {
    // console error for the moment
    console.error(`\n${file}`);
    console.error(e);
  }

  const result: ReportItem = {
    action: path.extname(file),
    originalSize: stats.size,
    compressedSize: stats.size,
  };

  // Writedata
  if (writeData && writeData.length < result.originalSize) {
    result.compressedSize = writeData.length;

    if (!$state.args.nowrite) {
      await fs.writeFile(file, writeData);
    }
  }

  $state.compressedFiles.add(file);
  $state.reportSummary(result);
};

function createWebpOptions(opt: WebpOptions | undefined): sharp.WebpOptions {
  return {
    nearLossless: opt!.mode === 'lossless',
    quality: opt!.quality,
    effort: opt!.effort,
  };
}

export const compressImage = async (
  data: Buffer,
  options: {
    resize?: sharp.ResizeOptions;
    toFormat?: 'webp' | 'pjpg' | 'avif' | 'unchanged';
  }
): Promise<Image | undefined> => {
  const cacheHash = computeCacheHash(data, options);
  const imageFromCache = await getFromCacheCompressImage(cacheHash);
  if (imageFromCache) {
    return imageFromCache;
  }

  // Load modifiable toFormat
  let toFormat = options.toFormat || 'unchanged';

  if (!config.image.compress) return undefined;

  let sharpFile = await sharp(data, { animated: true });
  const meta = await sharpFile.metadata();

  if (meta.pages && meta.pages > 1) {
    // Skip animated images for the moment.
    return undefined;
  }

  let outputFormat: ImageFormat;

  // Special case for svg
  if (meta.format === 'svg') {
    const newData = svgo(data, {
      multipass: true,
      plugins: [
        {
          name: 'preset-default',
          params: {
            overrides: {
              removeViewBox: false,
            },
          },
        },
      ],
    });
    if (newData.error || newData.modernError) {
      console.log(`Error processing svg ${data}`);
      return undefined;
    }
    return { format: 'svg', data: Buffer.from(newData.data, 'utf8') };
  }

  // The bitmap images
  if (toFormat === 'unchanged') {
    switch (meta.format) {
      case 'png':
        sharpFile = sharpFile.png(config.image.png.options || {});
        outputFormat = 'png';
        break;
      case 'jpeg':
      case 'jpg':
        sharpFile = sharpFile.jpeg(config.image.jpeg.options || {});
        outputFormat = 'jpg';
        break;
      case 'webp':
        sharpFile = sharpFile.webp(
          createWebpOptions(config.image.webp.options_lossly) || {}
        );
        outputFormat = 'webp';
        break;
      case 'avif':
        sharpFile = sharpFile.avif();
        outputFormat = 'avif';
        break;
    }
  } else {
    // To format
    switch (toFormat) {
      case 'pjpg':
        sharpFile = sharpFile.jpeg(
          { ...config.image.jpeg.options, progressive: true } || {}
        );
        outputFormat = 'jpg';
        break;
      case 'webp':
        sharpFile = sharpFile.webp(
          createWebpOptions(
            meta.format === 'png'
              ? config.image.webp.options_lossless
              : config.image.webp.options_lossly
          )
        );
        outputFormat = 'webp';
        break;
      case 'avif':
        sharpFile = sharpFile.avif({ effort: 6 });
        outputFormat = 'avif';
        break;
    }
  }

  // Unknow input format or output format
  // Can't do
  if (!outputFormat) return undefined;

  // If resize is requested
  if (options.resize?.width && options.resize?.height) {
    sharpFile = sharpFile.resize({
      ...options.resize,
      fit: 'fill',
      withoutEnlargement: true,
    });
  }

  //
  // Output image processed
  //

  // Add to cache
  const outputImage: Image = {
    format: outputFormat,
    data: await sharpFile.toBuffer(),
  };

  await addToCacheCompressImage(cacheHash, outputImage);

  // Go
  return outputImage;
};

const compressImageFile = async (file: string): Promise<Image | undefined> => {
  const buffer = await fs.readFile(file);
  return compressImage(buffer, {});
};

export async function compress(exclude: string): Promise<void> {
  const spinner = ora(getProgressText()).start();

  const globs = ['**/**'];
  if (exclude) globs.push('!' + exclude);
  const paths = await globby(globs, { cwd: $state.dir, absolute: true });

  // "Parallel" processing
  await Promise.all(
    paths.map(async (file) => {
      if (!$state.compressedFiles.has(file)) {
        await processFile(file, await fs.stat(file));
        spinner.text = getProgressText();
      }
    })
  );

  spinner.text = getProgressText();
  spinner.succeed();
}

const getProgressText = (): string => {
  const gain =
    $state.summary.dataLenUncompressed - $state.summary.dataLenCompressed;
  return `${$state.summary.nbFiles} files | ${formatBytes(
    $state.summary.dataLenUncompressed
  )} → ${formatBytes($state.summary.dataLenCompressed)} | -${formatBytes(
    gain
  )} `;
};
