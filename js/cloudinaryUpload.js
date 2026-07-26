import { CLOUDINARY_CLOUD_NAME, CLOUDINARY_UPLOAD_PRESET, UPLOAD_TIMEOUT_MS } from './config.js';

const UPLOAD_URL = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/video/upload`;

// A poster-frame derivative of the uploaded video, generated on the fly by
// Cloudinary's URL transformation syntax (so_0 = the frame at 0s) rather
// than anything computed client-side - free on the same upload, so an
// uploaded clip gets a real reveal-podium thumbnail instead of the generic
// fallback tile Instagram is stuck with (see reveal.js's buildThumb).
function thumbnailUrl(publicId) {
  return `https://res.cloudinary.com/${CLOUDINARY_CLOUD_NAME}/video/upload/so_0/${publicId}.jpg`;
}

// Uploads a device video (the "upload a video" alternative to pasting a
// link - see submission.js) directly to Cloudinary via an unsigned preset,
// no backend involved. `hash` is the file's own content hash, computed by
// the caller (submission.js) exactly as before - kept as `canonicalId` so
// scoring.js's merge/dedup logic (two players uploading identical bytes
// collapse into one weighted entry) needs no changes, same as it needed
// none for the original Firebase Storage version.
//
// Returns { task, promise }: `task.cancel()` aborts the in-flight upload
// (e.g. the player switches this slot back to "paste a link" mid-upload -
// mirrors the uploadBytesResumable task's .cancel() the Firebase Storage
// version used), and `promise` resolves to the same entry shape a
// resolved link produces: { url, platform, canonicalId, thumbnail, title,
// author, embedHtml }.
export function uploadClipVideo(code, round, file, hash, onProgress) {
  const xhr = new XMLHttpRequest();

  const promise = new Promise((resolve, reject) => {
    xhr.open('POST', UPLOAD_URL);
    xhr.timeout = UPLOAD_TIMEOUT_MS;

    xhr.upload.onprogress = e => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    };

    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(`CLOUDINARY_UPLOAD_FAILED_${xhr.status}`));
        return;
      }
      let data;
      try {
        data = JSON.parse(xhr.responseText);
      } catch (err) {
        reject(err);
        return;
      }
      resolve({
        url: data.secure_url,
        platform: 'upload',
        canonicalId: hash,
        thumbnail: thumbnailUrl(data.public_id),
        title: file.name.replace(/\.[^.]+$/, ''),
        author: '',
        embedHtml: null,
      });
    };
    xhr.onerror = () => reject(new Error('CLOUDINARY_UPLOAD_FAILED'));
    xhr.ontimeout = () => reject(new Error('TIMED_OUT'));
    xhr.onabort = () => reject(new Error('UPLOAD_CANCELLED'));

    const form = new FormData();
    form.append('file', file);
    form.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);
    // Folders the upload under the room/round in Cloudinary's own asset
    // browser purely for the user's manual housekeeping later - Cloudinary
    // deletion requires a signed request with the account's API secret,
    // which this static, backend-less frontend deliberately never holds,
    // so there's no automatic cleanup path here (see output.md).
    form.append('folder', `tragedy-of-the-commons/${code}/${round}`);
    xhr.send(form);
  });

  return { task: { cancel: () => xhr.abort() }, promise };
}
