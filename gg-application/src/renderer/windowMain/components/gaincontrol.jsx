import { Slider } from "@/components/ui/slider";

function GainControl({ value, onChange, onCommit, label, quietLabel, loudLabel, disabled, max = 1 }) {
    const sliderPercentage = `${Math.round(value * 100)}%`;
    const sliderTickCount = Math.round(max * 10);
    const sliderTicks = Array.from({ length: sliderTickCount + 1 }, (_, index) => ({
        value: index / 10,
        label: index === 0 || index === sliderTickCount / 2 || index === sliderTickCount ? `${index * 10}%` : undefined
    }));

    return (
        <div>
            <div className="mb-6 flex items-start justify-between gap-4">
                <span className="font-semibold">{label}</span>
                <span className="text-xl font-semibold tabular-nums">{sliderPercentage}</span>
            </div>

            <Slider
                min={0}
                max={max}
                step={0.01}
                value={[value]}
                disabled={disabled}
                onValueChange={([nextValue]) => onChange(nextValue)}
                onValueCommit={([nextValue]) => {
                    if (!disabled) onCommit(nextValue);
                }}
                sliderTicks={sliderTicks}
                referenceLabels={[
                    { value: 0, label: quietLabel },
                    { value: max, label: loudLabel }
                ]}
                className="py-3"
            />
        </div>
    );
}

export { GainControl };
