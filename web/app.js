/* Zap Tats request form.
   Saves a request to Supabase, uploads reference photos to the private "request-images"
   bucket, and records which photos belong to the request. All access rules live in the
   database (see supabase/001_requests.sql), not in this file. */
(function () {
  'use strict';

  var cfg = window.ZAPTATS_CONFIG || {};
  var MAX_PHOTOS = 5;
  var MAX_DIMENSION = 1600;
  var JPEG_QUALITY = 0.85;
  var MAX_BYTES = 5 * 1024 * 1024;
  var BUCKET = 'request-images';
  var ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
  var CONTACT = '(573) 337-0502';

  function $(id) { return document.getElementById(id); }

  var form = $('request-form');
  var alertBox = $('form-alert');
  var sendBtn = $('send');
  var photosInput = $('photos');
  var thumbs = $('thumbs');
  var noPic = $('nopic');
  var photoBlock = $('photo-block');
  var describeBlock = $('describe-block');
  var minorBlock = $('minor-block');
  var doneBox = $('done');

  var client = null;
  try {
    client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    });
  } catch (err) {
    console.error('Could not start the database connection', err);
  }

  var photos = [];      // { file, url, path, recorded }
  var savedId = null;   // set once the request row is saved, so a retry never duplicates it
  var sending = false;

  /* ---------- small helpers ---------- */

  function uuid() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    var b = new Uint8Array(16);
    window.crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  function val(id) { return $(id).value.trim(); }
  function digits(s) { return s.replace(/\D/g, ''); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  function showAlert(msg) {
    alertBox.textContent = msg;
    alertBox.hidden = false;
  }
  function clearAlert() {
    alertBox.hidden = true;
    alertBox.textContent = '';
  }

  function setError(id, msg) {
    var el = $('err-' + id);
    var field = $(id);
    if (!el) return;
    if (msg) {
      el.textContent = msg;
      el.hidden = false;
      if (field) { field.setAttribute('aria-invalid', 'true'); field.setAttribute('aria-describedby', 'err-' + id); }
    } else {
      el.textContent = '';
      el.hidden = true;
      if (field) { field.removeAttribute('aria-invalid'); field.removeAttribute('aria-describedby'); }
    }
  }

  function clearErrors() {
    ['name', 'phone', 'email', 'photos', 'description', 'placement', 'size', 'adult', 'minor-age', 'parent-name', 'parent-phone']
      .forEach(function (id) { setError(id, ''); });
    // keep the photo input's own description link intact
    photosInput.setAttribute('aria-describedby', 'photos-hint err-photos');
  }

  /* ---------- photos ---------- */

  function isImageFile(file) {
    return /^image\//.test(file.type) || /\.(heic|heif)$/i.test(file.name || '');
  }

  function renderThumbs() {
    thumbs.innerHTML = '';
    photos.forEach(function (p, i) {
      var li = document.createElement('li');
      var img = document.createElement('img');
      img.src = p.url;
      img.alt = 'Photo ' + (i + 1);
      img.onerror = function () { img.removeAttribute('src'); };
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'remove';
      btn.textContent = '×';
      btn.setAttribute('aria-label', 'Remove photo ' + (i + 1));
      btn.addEventListener('click', function () {
        URL.revokeObjectURL(p.url);
        photos.splice(photos.indexOf(p), 1);
        renderThumbs();
        setError('photos', '');
      });
      li.appendChild(img);
      li.appendChild(btn);
      thumbs.appendChild(li);
    });
  }

  photosInput.addEventListener('change', function () {
    var picked = Array.prototype.slice.call(photosInput.files || []);
    var skippedType = 0;
    var skippedCount = 0;
    picked.forEach(function (file) {
      if (!isImageFile(file)) { skippedType++; return; }
      if (photos.length >= MAX_PHOTOS) { skippedCount++; return; }
      photos.push({ file: file, url: URL.createObjectURL(file), path: null, recorded: false });
    });
    photosInput.value = '';
    renderThumbs();
    if (skippedCount) {
      setError('photos', 'You can add up to ' + MAX_PHOTOS + ' photos. The extra ' + (skippedCount === 1 ? 'one was' : 'ones were') + ' left out.');
    } else if (skippedType) {
      setError('photos', 'Only photos can be added here. Pick image files.');
    } else {
      setError('photos', '');
    }
  });

  // Shrink big phone photos so uploads are fast and storage lasts. Falls back to the
  // original file if the browser cannot decode it and the file is small enough.
  function toJpeg(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        try {
          var w = img.naturalWidth;
          var h = img.naturalHeight;
          var scale = Math.min(1, MAX_DIMENSION / Math.max(w, h));
          var cw = Math.max(1, Math.round(w * scale));
          var ch = Math.max(1, Math.round(h * scale));
          var canvas = document.createElement('canvas');
          canvas.width = cw;
          canvas.height = ch;
          var ctx = canvas.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, cw, ch);
          ctx.drawImage(img, 0, 0, cw, ch);
          canvas.toBlob(function (blob) {
            URL.revokeObjectURL(url);
            if (blob) resolve(blob); else reject(new Error('Could not encode photo'));
          }, 'image/jpeg', JPEG_QUALITY);
        } catch (e) {
          URL.revokeObjectURL(url);
          reject(e);
        }
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('Could not read photo'));
      };
      img.src = url;
    });
  }

  function extFor(type) {
    return { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif' }[type] || 'jpg';
  }

  function preparePhoto(file) {
    return toJpeg(file).then(function (blob) {
      return { blob: blob, type: 'image/jpeg', ext: 'jpg' };
    }, function () {
      if (ALLOWED_TYPES.indexOf(file.type) !== -1 && file.size <= MAX_BYTES) {
        return { blob: file, type: file.type, ext: extFor(file.type) };
      }
      throw new Error('Photo could not be prepared');
    });
  }

  /* ---------- show / hide parts of the form ---------- */

  noPic.addEventListener('change', function () {
    photoBlock.hidden = noPic.checked;
    describeBlock.hidden = !noPic.checked;
    setError('photos', '');
    setError('description', '');
  });

  Array.prototype.forEach.call(form.querySelectorAll('input[name="adult"]'), function (r) {
    r.addEventListener('change', function () {
      minorBlock.hidden = !$('adult-no').checked;
      setError('adult', '');
    });
  });

  /* ---------- validation ---------- */

  function validate() {
    clearErrors();
    var first = null;
    function fail(id, msg, focusId) {
      setError(id, msg);
      if (!first) first = focusId || id;
    }

    if (!val('name')) fail('name', 'Enter your name.');
    var phone = val('phone');
    if (digits(phone).length < 7) fail('phone', 'Enter a phone number I can reach you at.');
    var email = val('email');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('email', 'Enter a valid email address, like name@example.com.');

    if (noPic.checked) {
      if (!val('description')) fail('description', 'Describe the tattoo you want.');
    } else if (photos.length === 0) {
      fail('photos', 'Add a photo, or check “I don’t have a picture.”');
    }

    if (!val('placement')) fail('placement', 'Say where on your body you want it.');
    if (!val('size')) fail('size', 'Give me a rough size.');

    var adultYes = $('adult-yes').checked;
    var adultNo = $('adult-no').checked;
    if (!adultYes && !adultNo) {
      fail('adult', 'Choose yes or no.', 'adult-yes');
    } else if (adultNo) {
      var age = val('minor-age');
      var n = /^\d{1,2}$/.test(age) ? parseInt(age, 10) : NaN;
      if (!(n >= 1 && n <= 17)) fail('minor-age', 'Enter your age as a number from 1 to 17.');
      if (!val('parent-name')) fail('parent-name', 'Enter a parent or guardian’s name.');
      if (digits(val('parent-phone')).length < 7) fail('parent-phone', 'Enter a phone number for your parent or guardian.');
    }

    return first;
  }

  function buildRow(id) {
    var adult = $('adult-yes').checked;
    var picture = !noPic.checked;
    return {
      id: id,
      name: val('name'),
      phone: val('phone'),
      email: val('email'),
      placement: val('placement'),
      size: val('size'),
      has_picture: picture,
      description: picture ? null : val('description'),
      style: !picture && val('style') ? val('style') : null,
      is_adult: adult,
      minor_age: adult ? null : parseInt(val('minor-age'), 10),
      parent_name: adult ? null : val('parent-name'),
      parent_phone: adult ? null : val('parent-phone')
    };
  }

  /* ---------- sending ---------- */

  function setBusy(busy) {
    sendBtn.disabled = busy;
    sendBtn.textContent = busy ? 'Sending…' : 'Send request';
  }

  function showDone(name) {
    var first = (name || '').split(/\s+/)[0];
    $('done-text').textContent = (first ? 'Thanks, ' + first + '. ' : 'Thanks. ') +
      'I have your request and I’ll reply by phone, text, or email once I’ve looked it over.';
    form.hidden = true;
    doneBox.hidden = false;
    window.scrollTo(0, 0);
    $('done-title').focus();
  }

  function resetAll() {
    photos.forEach(function (p) { URL.revokeObjectURL(p.url); });
    photos = [];
    savedId = null;
    form.reset();
    renderThumbs();
    clearErrors();
    clearAlert();
    photoBlock.hidden = false;
    describeBlock.hidden = true;
    minorBlock.hidden = true;
    doneBox.hidden = true;
    form.hidden = false;
    window.scrollTo(0, 0);
    $('name').focus();
  }

  $('again').addEventListener('click', resetAll);

  function uploadPending() {
    // Photos are uploaded one at a time; a failure on one does not stop the others.
    var failed = 0;
    var chain = Promise.resolve();
    photos.forEach(function (p, i) {
      if (p.path) return;
      chain = chain.then(function () {
        return preparePhoto(p.file).then(function (prepared) {
          var path = savedId + '/' + (i + 1) + '-' + Math.random().toString(36).slice(2, 8) + '.' + prepared.ext;
          return client.storage.from(BUCKET).upload(path, prepared.blob, { contentType: prepared.type, upsert: false })
            .then(function (res) {
              if (res && res.error) throw res.error;
              p.path = path;
            });
        }).catch(function (err) {
          console.error('Photo upload failed', err);
          failed++;
        });
      });
    });
    return chain.then(function () { return failed; });
  }

  function recordPhotos() {
    var pending = photos.filter(function (p) { return p.path && !p.recorded; });
    if (!pending.length) return Promise.resolve(0);
    var rows = pending.map(function (p) { return { request_id: savedId, storage_path: p.path }; });
    return client.from('request_images').insert(rows).then(function (res) {
      if (res && res.error) throw res.error;
      pending.forEach(function (p) { p.recorded = true; });
      return 0;
    });
  }

  function onSubmit(event) {
    event.preventDefault();
    if (sending) return;
    clearAlert();

    // Spam trap filled in: act as if it worked, send nothing.
    if ($('website').value) { showDone(val('name')); return; }

    var firstBad = validate();
    if (firstBad) {
      showAlert('Some answers need fixing. They’re marked below.');
      var target = $(firstBad);
      if (target) target.focus();
      return;
    }
    if (!client) {
      showAlert('This form isn’t working right now. Please call or text ' + CONTACT + ' instead.');
      return;
    }

    sending = true;
    setBusy(true);

    var saveRequest;
    if (savedId) {
      saveRequest = Promise.resolve();
    } else {
      var id = uuid();
      saveRequest = client.from('tattoo_requests').insert(buildRow(id)).then(function (res) {
        if (res && res.error) throw res.error;
        savedId = id;
      });
    }

    saveRequest.then(function () {
      if (noPic.checked) return 0;
      return uploadPending().then(function (failedUploads) {
        return recordPhotos().then(function () { return failedUploads; }, function (err) {
          console.error('Could not link photos to the request', err);
          return failedUploads + photos.filter(function (p) { return p.path && !p.recorded; }).length;
        });
      });
    }).then(function (failedPhotos) {
      if (failedPhotos) {
        showAlert('Your request was saved, but ' + plural(failedPhotos, 'photo', 'photos') +
          ' didn’t upload. Press “Send request” again to retry just the photos, or text them to ' + CONTACT + '.');
      } else {
        showDone(val('name'));
      }
    }, function (err) {
      console.error('Could not save the request', err);
      showAlert('Your request didn’t send. Check your connection and try again. If it keeps happening, call or text ' + CONTACT + '.');
    }).then(function () {
      sending = false;
      setBusy(false);
    });
  }

  form.addEventListener('submit', onSubmit);
})();
