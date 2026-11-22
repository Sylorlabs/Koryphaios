// Creates a display with no physical output, so a native fixture window is composited by the
// window server without ever appearing on the operator's screen. The window server still renders
// it, which is what makes `screencapture -l` a real observation of the app under test.
#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#import <objc/message.h>

static id makeDisplay(void) {
    Class descriptorClass = NSClassFromString(@"CGVirtualDisplayDescriptor");
    Class settingsClass = NSClassFromString(@"CGVirtualDisplaySettings");
    Class displayClass = NSClassFromString(@"CGVirtualDisplay");
    Class modeClass = NSClassFromString(@"CGVirtualDisplayMode");
    if (!descriptorClass || !settingsClass || !displayClass || !modeClass) return nil;

    id descriptor = [[descriptorClass alloc] init];
    [descriptor setValue:@"kory-eval-display" forKey:@"name"];
    [descriptor setValue:@1920 forKey:@"maxPixelsWide"];
    [descriptor setValue:@1080 forKey:@"maxPixelsHigh"];
    NSSize mm = NSMakeSize(500, 280);
    [descriptor setValue:[NSValue valueWithBytes:&mm objCType:@encode(NSSize)] forKey:@"sizeInMillimeters"];
    [descriptor setValue:@0x4b4f5259 forKey:@"serialNumber"];
    [descriptor setValue:@0x00001234 forKey:@"vendorID"];
    [descriptor setValue:@0x00005678 forKey:@"productID"];

    id display = [displayClass alloc];
    display = ((id (*)(id, SEL, id))objc_msgSend)(display, NSSelectorFromString(@"initWithDescriptor:"), descriptor);
    if (!display) return nil;

    id mode = [modeClass alloc];
    mode = ((id (*)(id, SEL, unsigned long, unsigned long, double))objc_msgSend)(
        mode, NSSelectorFromString(@"initWithWidth:height:refreshRate:"), 1920, 1080, 60.0);
    id settings = [[settingsClass alloc] init];
    [settings setValue:@[mode] forKey:@"modes"];
    [settings setValue:@1 forKey:@"hiDPI"];
    [display performSelector:NSSelectorFromString(@"applySettings:") withObject:settings];
    return display;
}

int main(int argc, char **argv) {
    @autoreleasepool {
        NSTimeInterval hold = argc > 1 ? atof(argv[1]) : 600.0;
        id display = makeDisplay();
        if (!display) {
            printf("error=no-private-display\n");
            fflush(stdout);
            return 1;
        }
        NSNumber *ident = [display valueForKey:@"displayID"];
        NSString *wanted = @"kory-eval-display";
        NSScreen *target = nil;
        for (int attempt = 0; attempt < 40 && !target; attempt++) {
            for (NSScreen *screen in NSScreen.screens) {
                if ([screen.localizedName isEqualToString:wanted]) { target = screen; break; }
            }
            if (!target) usleep(150000);
        }
        if (!target) {
            printf("error=display-not-registered\n");
            fflush(stdout);
            return 2;
        }
        NSRect frame = target.frame;
        // Accessibility positions use a top-left origin on the primary display, while NSScreen uses
        // a bottom-left origin. The driver needs the accessibility form to place the window here.
        CGFloat primaryHeight = frame.size.height;
        for (NSScreen *screen in NSScreen.screens) {
            if (screen.frame.origin.x == 0 && screen.frame.origin.y == 0) {
                primaryHeight = screen.frame.size.height;
                break;
            }
        }
        int ax_y = (int)(primaryHeight - (frame.origin.y + frame.size.height));
        printf("display=%u frame=%dx%d+%d+%d ax=%d,%d screens=%lu\n", ident.unsignedIntValue,
               (int)frame.size.width, (int)frame.size.height, (int)frame.origin.x, (int)frame.origin.y,
               (int)frame.origin.x, ax_y, (unsigned long)NSScreen.screens.count);
        fflush(stdout);
        // The display lives exactly as long as this process. It is released on exit.
        [NSThread sleepForTimeInterval:hold];
        display = nil;
        printf("released\n");
        fflush(stdout);
    }
    return 0;
}
