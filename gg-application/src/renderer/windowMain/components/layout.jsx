function Layout({ title, description, children, actions }) {
    return (
        <section className="mx-auto flex w-full max-w-5xl flex-1 flex-col">
            <header className="mb-8 border-b border-heading pb-5">
                <h1 className="mb-3 text-3xl font-semibold tracking-tight text-heading sm:text-4xl">{title}</h1>
                <p className="text-muted-foreground">{description}</p>
            </header>

            <div className="flex flex-1 flex-col">{children}</div>

            {actions && <footer className="mt-8 flex flex-wrap justify-end gap-3">{actions}</footer>}
        </section>
    );
}

export { Layout };
