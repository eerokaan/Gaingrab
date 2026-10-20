import { Direction, Slider as SliderPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

function Slider({ className, defaultValue, value, min = 0, max = 100, orientation = "horizontal", dir, inverted = false, referenceLabels = [], ticks = [], ...props }) {
    const values = Array.isArray(value) ? value : Array.isArray(defaultValue) ? defaultValue : [min, max];
    const direction = Direction.useDirection(dir);
    const horizontal = orientation === "horizontal";
    const reversed = horizontal ? (direction === "rtl") !== inverted : !inverted;
    const decorated = referenceLabels.length > 0 || ticks.length > 0;

    const positionEntry = (entryValue) => {
        const fraction = max === min ? 0 : Math.min(1, Math.max(0, (entryValue - min) / (max - min)));
        const position = reversed ? 1 - fraction : fraction;
        const anchor = position === 0 ? 0 : position === 1 ? 100 : 50;
        return { position: { [horizontal ? "left" : "top"]: `${position * 100}%` }, transform: `translate${horizontal ? "X" : "Y"}(-${anchor}%)` };
    };

    const slider = (
        <SliderPrimitive.Root data-slot="slider" defaultValue={defaultValue} value={value} min={min} max={max} orientation={orientation} dir={direction} inverted={inverted} className={cn("relative flex w-full touch-none items-center select-none data-disabled:opacity-50 data-vertical:h-full data-vertical:min-h-40 data-vertical:w-auto data-vertical:flex-col", className)} {...props}>
            <SliderPrimitive.Track data-slot="slider-track" className="relative grow overflow-hidden rounded-full bg-muted data-horizontal:h-1 data-horizontal:w-full data-vertical:h-full data-vertical:w-1">
                <SliderPrimitive.Range data-slot="slider-range" className="absolute bg-primary select-none data-horizontal:h-full data-vertical:w-full" />
            </SliderPrimitive.Track>
            {values.map((_, index) => (
                <SliderPrimitive.Thumb data-slot="slider-thumb" key={index} className="relative block size-3 shrink-0 rounded-full border border-ring bg-white ring-ring/50 transition-[color,box-shadow] select-none after:absolute after:-inset-2 hover:ring-3 focus-visible:ring-3 focus-visible:outline-hidden active:ring-3 disabled:pointer-events-none disabled:opacity-50" />
            ))}
            {decorated && (
                <span data-slot="slider-scale" className={cn("pointer-events-none absolute text-xs font-medium text-muted-foreground select-none", horizontal ? "inset-0" : "top-0 left-full ml-3 flex h-full gap-3")}>
                    {/* The size-3 thumb's half-width inset matches Radix's in-bounds center travel. */}
                    {ticks.length > 0 && (
                        <span className={horizontal ? "absolute inset-x-1.5 top-full block h-8" : "relative my-1.5 block w-14"}>
                            {ticks.map(({ value: tickValue, label }, index) => {
                                const { position, transform } = positionEntry(tickValue);
                                const labeled = label !== undefined && label !== null;
                                return (
                                    <span key={index} data-slot="slider-tick" data-value={tickValue} data-labeled={labeled} className={horizontal ? "absolute top-0" : "absolute left-0"} style={position}>
                                        <span data-slot="slider-tick-mark" className={cn("block bg-muted-foreground/70", horizontal ? "w-px -translate-x-1/2" : "h-px -translate-y-1/2", horizontal ? (labeled ? "h-2" : "h-1") : labeled ? "w-2" : "w-1")} />
                                        {labeled && (
                                            <span data-slot="slider-tick-label" className={cn("absolute whitespace-nowrap tabular-nums", horizontal ? "top-3 left-0" : "top-0 left-3")} style={{ transform }}>
                                                {label}
                                            </span>
                                        )}
                                    </span>
                                );
                            })}
                        </span>
                    )}
                    {referenceLabels.length > 0 && (
                        <span className={horizontal ? "absolute inset-x-1.5 bottom-full block h-5 text-sm" : "relative my-1.5 block w-24 text-sm"}>
                            {referenceLabels.map(({ value: referenceValue, label }, index) => {
                                const { position, transform } = positionEntry(referenceValue);
                                return (
                                    <span key={index} data-slot="slider-reference" data-value={referenceValue} className={cn("absolute whitespace-nowrap", horizontal ? "top-0" : "left-0")} style={{ ...position, transform }}>
                                        {label}
                                    </span>
                                );
                            })}
                        </span>
                    )}
                </span>
            )}
        </SliderPrimitive.Root>
    );

    if (!decorated) return slider;

    // Reserve decoration space without changing Radix's interactive dimensions
    const scaleSpace = horizontal ? cn(ticks.length > 0 && "pb-8", referenceLabels.length > 0 && "pt-7") : ticks.length && referenceLabels.length ? "pr-44" : ticks.length ? "pr-17" : "pr-27";

    return (
        <div data-slot="slider-layout" className={cn(horizontal ? "w-full" : "h-full min-h-40 w-fit", scaleSpace)}>
            {slider}
        </div>
    );
}

export { Slider };
