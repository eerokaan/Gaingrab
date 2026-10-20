import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

function RatingScale({ items, value, onChange, disabled }) {
    return (
        <RadioGroup
            value={value === null ? "" : String(value)}
            disabled={disabled}
            onValueChange={(nextValue) => {
                if (!disabled) onChange(Number(nextValue));
            }}
            className="gap-3"
        >
            {items.map((item) => (
                <label key={item.value} className="flex min-h-9 cursor-pointer items-center gap-3 has-disabled:cursor-not-allowed">
                    <RadioGroupItem value={String(item.value)} />
                    <span className="flex-1">
                        <span className="mr-3 font-semibold tabular-nums">{item.value}</span>
                        {item.label}
                    </span>
                </label>
            ))}
        </RadioGroup>
    );
}

function RatingLegend({ items }) {
    return (
        <ol className="grid grid-cols-[repeat(5,minmax(8rem,1fr))] gap-4 overflow-x-auto">
            {items.map((item) => (
                <li key={item.value} className="rounded-lg border bg-muted/50 p-4 text-center">
                    <span className="mb-2 block text-3xl font-semibold text-heading tabular-nums">{item.value}</span>
                    <span className="block text-sm">{item.label}</span>
                </li>
            ))}
        </ol>
    );
}

export { RatingLegend, RatingScale };
