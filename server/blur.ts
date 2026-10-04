/**
 * `BLUR_M` is an Objective-C source file compiled into `Contents/Resources/blur.node`
 * by `compileBlur`. It is a hand-written N-API addon (no node headers — just the
 * handful of `napi_*` prototypes it calls, resolved at load time in the host
 * process via `-undefined dynamic_lookup`) exposing `setBlur(buffer, radius)` and
 * `matchCorners(buffer)`. `buffer` holds the `NSView*` returned by Electron's
 * `win.getNativeWindowHandle()`; both resolve `[view window]`. `setBlur` calls the
 * private `CGSSetWindowBackgroundBlurRadius` (via `dlsym`, so the addon still loads
 * — just becomes a no-op — if the symbols ever disappear) on the main thread.
 * `matchCorners` makes the window server's corner radius follow AppKit's corner
 * mask (see the comment above `MatchCorners`).
 */

import { execFile } from "node:child_process";

export const BLUR_M = `#import <Cocoa/Cocoa.h>
#import <dispatch/dispatch.h>
#import <dlfcn.h>
#import <objc/message.h>
#import <objc/runtime.h>
#import <stdbool.h>
#import <stdint.h>

#define NAPI_AUTO_LENGTH ((size_t)-1)

typedef void *napi_env;
typedef void *napi_value;
typedef void *napi_callback_info;
typedef int napi_status;
typedef napi_value (*napi_callback)(napi_env env, napi_callback_info info);

extern napi_status napi_create_function(napi_env env, const char *utf8name, size_t length,
                                         napi_callback cb, void *data, napi_value *result);
extern napi_status napi_set_named_property(napi_env env, napi_value object, const char *utf8name,
                                            napi_value value);
extern napi_status napi_get_cb_info(napi_env env, napi_callback_info cbinfo, size_t *argc,
                                     napi_value *argv, napi_value *this_arg, void **data);
extern napi_status napi_get_buffer_info(napi_env env, napi_value value, void **data,
                                         size_t *length);
extern napi_status napi_get_value_int32(napi_env env, napi_value value, int32_t *result);
extern napi_status napi_get_boolean(napi_env env, bool value, napi_value *result);

typedef int CGSConnectionID;
typedef CGSConnectionID (*CGSMainConnectionIDFn)(void);
typedef int (*CGSSetWindowBackgroundBlurRadiusFn)(CGSConnectionID cid, int windowNumber,
                                                    int radius);

static napi_value SetBlur(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);

  bool issued = false;

  void *data = NULL;
  size_t length = 0;
  if (argc >= 2) {
    napi_get_buffer_info(env, argv[0], &data, &length);
  }

  if (data != NULL && length >= sizeof(void *)) {
    NSView *view = *(NSView *__unsafe_unretained *)data;
    NSWindow *window = view != nil ? [view window] : nil;

    if (window != nil && [window windowNumber] > 0) {
      CGSMainConnectionIDFn mainConnectionId =
          (CGSMainConnectionIDFn)dlsym(RTLD_DEFAULT, "CGSMainConnectionID");
      CGSSetWindowBackgroundBlurRadiusFn setWindowBlur =
          (CGSSetWindowBackgroundBlurRadiusFn)dlsym(RTLD_DEFAULT,
                                                     "CGSSetWindowBackgroundBlurRadius");

      if (mainConnectionId != NULL && setWindowBlur != NULL) {
        int32_t radius = 0;
        napi_get_value_int32(env, argv[1], &radius);

        NSInteger windowNumber = [window windowNumber];
        void (^applyBlur)(void) = ^{
          setWindowBlur(mainConnectionId(), (int)windowNumber, (int)radius);
        };

        if ([NSThread isMainThread]) {
          applyBlur();
        } else {
          dispatch_async(dispatch_get_main_queue(), applyBlur);
        }
        issued = true;
      }
    }
  }

  napi_value result;
  napi_get_boolean(env, issued, &result);
  return result;
}

// A transparent window's corner mask leaves the shadow to the window's alpha
// ("content aware"), and AppKit then gives the window server a corner radius
// of 0 while clipping the content itself at the system radius. The blur and the
// window outline follow the window server's shape, so they spill past the
// rounded content. AppKit recomputes the mask on appearance changes and
// fullscreen, so the fix overrides the decision instead of setting the radius
// once: with the mask defining the shadow shape, AppKit sends its own radius.
static BOOL CornerMaskDefinesShadow(id self, SEL _cmd) { return YES; }

static napi_value MatchCorners(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);

  bool issued = false;

  void *data = NULL;
  size_t length = 0;
  if (argc >= 1) {
    napi_get_buffer_info(env, argv[0], &data, &length);
  }

  if (data != NULL && length >= sizeof(void *)) {
    NSView *view = *(NSView *__unsafe_unretained *)data;
    NSWindow *window = view != nil ? [view window] : nil;
    SEL definesShadow = sel_registerName("_cornerMaskShouldDefineShadow");
    SEL maskChanged = sel_registerName("_cornerMaskChanged");

    if (window != nil && [window respondsToSelector:definesShadow] &&
        [window respondsToSelector:maskChanged]) {
      void (^apply)(void) = ^{
        class_addMethod([window class], definesShadow, (IMP)CornerMaskDefinesShadow, "B@:");
        ((void (*)(id, SEL))objc_msgSend)(window, maskChanged);
      };

      if ([NSThread isMainThread]) {
        apply();
      } else {
        dispatch_async(dispatch_get_main_queue(), apply);
      }
      issued = true;
    }
  }

  napi_value result;
  napi_get_boolean(env, issued, &result);
  return result;
}

__attribute__((visibility("default")))
napi_value napi_register_module_v1(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "setBlur", NAPI_AUTO_LENGTH, SetBlur, NULL, &fn);
  napi_set_named_property(env, exports, "setBlur", fn);
  napi_create_function(env, "matchCorners", NAPI_AUTO_LENGTH, MatchCorners, NULL, &fn);
  napi_set_named_property(env, exports, "matchCorners", fn);
  return exports;
}
`;

/**
 * `xcrun clang` flags `compileBlur` invokes with — exported so
 * `buildFingerprint` can hash them: a flag change (e.g. a different target
 * framework) changes the bytes `compileBlur` produces just as surely as an
 * edit to `BLUR_M` does, and the stamp must catch both.
 */
export const BLUR_CLANG_ARGS = [
  "clang",
  "-bundle",
  "-undefined",
  "dynamic_lookup",
  "-framework",
  "AppKit",
  "-fobjc-arc",
  "-x",
  "objective-c",
  "-o",
] as const;

/**
 * Compiles `BLUR_M` to `destPath` with `xcrun clang`, piping the source on stdin
 * so no temp `.m` file is needed. Returns a `patchAsar`-style note: `MISSED` with
 * the compiler's stderr (or the spawn error) on failure, `ok` on success.
 */
export function compileBlur(destPath: string): Promise<string> {
  const { promise, resolve } = Promise.withResolvers<string>();
  const child = execFile(
    "xcrun",
    [...BLUR_CLANG_ARGS, destPath, "-"],
    (error, _stdout, stderr) => {
      if (error) {
        resolve(`MISSED  window blur: ${stderr.trim() || error.message}`);
        return;
      }
      resolve("ok      window blur (compiled)");
    },
  );
  child.stdin!.end(BLUR_M);
  return promise;
}
