function getRatingResponses(__) {
    return [
        { value: 1, label: __("Much quieter than preferred") },
        { value: 2, label: __("Quieter than preferred") },
        { value: 3, label: __("Preferred") },
        { value: 4, label: __("Louder than preferred") },
        { value: 5, label: __("Much louder than preferred") }
    ];
}

export { getRatingResponses };
